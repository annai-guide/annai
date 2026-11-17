# Known limitations and deferrals

Each entry here was approved by the user. Reviewers read this file first and don't raise these again. Anything not listed here is still an open finding.

### A loud, jumping room sends one noise turn as a voice session opens
- **Kind:** known limitation.
- **What the user sees:** in a loud room whose noise jumps suddenly (about -45 to -40 dBFS, with steps of about 4 dB), about 1.5 s of room sound goes to the live model as a turn, 1.1 to 1.5 s after the microphone opens. Shiori may answer it with nothing. If Koe was about to say a reminder, it can be cut: in probes, 4 of 36 cases, against 2 of 36 before this change. The version before this change sends its own false turn in those rooms anyway, about 2 s later. In traffic, the first false turn is 0.9 s longer than before.
- **Why:** the detector learns the room only once it has heard it. A short word said the instant a new microphone stops giving zeros must be heard (the user asked for that), so sound over a guessed floor is held, and after a second it is judged against the room. A room that jumps looks like speech at that point. Three cheaper variants didn't fix it, and two of them lost the short words again.
- **Measured:** 2 of 27 synthetic changing rooms (`probe-live2` in the detector-floor review); the other 25 behave exactly as before.
- **Revisit when:** a phone test (device-checklist-phase2 L6, the car and loud-room step) shows it, or the detector is redesigned.
- **Approved:** 2026-10-23, the user: "Accept".

### On an iPhone, her voice's volume while she listens may be apart from the media volume
- **Kind:** known limitation.
- **What the user sees:** on an iPhone, while Shiori's microphone is open, the volume buttons may set her voice's volume apart from the volume of music and videos (iPhone most likely treats her voice as a call). Settings → Voice → Live voice says so on iPhone (`src/ui/screens/voice.js`, since 6fcc9d96).
- **Why:** the browser decides which volume a page's audio gets while the microphone is open; annai can't change it.
- **Revisit when:** a phone check shows the buttons do something else, or a browser lets a page keep media volume while it listens.
- **Approved:** 2026-11-11, the user's pick "Yes, with a help line (Recommended)" (from their drive). Written 2026-11-14, found missing by the scope audit.

### Gemini Live's key travels in the WebSocket address
- **Kind:** known limitation.
- **What the user sees:** nothing on screen. With a Gemini key and Live voice, annai opens Google's Live socket with the key in its address (`?key=…`, plugins-official/gemini-live/index.js:4), not in a header. It goes to Google over TLS, but an address is more often logged along the way than a header.
- **Why:** a browser's WebSocket can't send its own headers, so the address is the only way it can carry the key. Google's short-lived tokens would keep the key out, but they must be minted by a server, and annai has none for this.
- **Revisit when:** Google lets a browser mint its own short-lived Live token, or annai gains a relay that could mint one.
- **Approved:** 2026-11-14, the user's pick "Known limitation (Recommended)". Found by the scope audit.

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
- **What the user sees:** on a phone turned on its side (740 x 360), Show on a stuck stack opens it in a box of 180 px, half the screen (measured again 2026-11-16 in Chromium and WebKit, once timeline stage 8 took the top bar away; it was about 152 px, half the room under the bar). A card taller than the box doesn't show whole: its title and Dismiss show, and its middle scrolls under the Dismiss; while a card's top is in the lower part of the box, its own Dismiss covers its title for a moment. Of the cards measured on 2026-11-09 (168 to 193 px), only those over 180 px still do; a newer-backup card is 155 px there and shows whole. In portrait every card shows whole.
- **Why:** every stuck box on home is at most half the screen, so the page never moves (the user's "Cap every box at half" and "Opens in place"); a short screen leaves a short box.
- **Revisit when:** the user's phone check finds it in the way, or a landscape layout for home is designed.
- **Approved:** 2026-11-09, the user chose "Known limitation".

### annai's card's question is answered by tap only
- **Kind:** known limitation.
- **What the user sees:** annai's card ("Read <trip>?", "Carry on in <trip>?") is answered by its buttons (Allow or Always for my trips, Open, Not now), in the car too. Under its buttons the card says "Tap to answer" while it waits (since 2026-11-13, the user's pick "Fixed line on the card"). With voice on annai still says the question aloud; then the card waits for a tap, and nothing listens for a spoken yes. With one Shiori (no Koe model) the microphone stays closed after the question, so a "yes" said then isn't heard, and the card waits. Where a microphone does hear (Koe set up, whose microphone hears on; or a tap on Shiori, which opens her ordinary microphone for 8 seconds), a spoken "no" still declines, and any other line Shiori keeps, a "yes" included, ends the card unanswered ("Not read", "Not opened"): Shiori is told that the card is closed and that only a tap answers it; when they meant yes she asks again with a new card (its buttons work; the closed card's go grey), and the new card says "Tap to answer". Opus also says that only a tap answers; Sonnet showed the new card without a word 19 of 19 times in a real run, so a user who isn't looking at the screen hears no reason; Koe may answer the line with an okay in the language it answers in. Nothing is read or opened by voice. Before 2026-11-13 a yes in the 20 seconds after the question said aloud answered the card (8 of 8 in live voice, 10 of 10 in classic voice, in real runs).
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
- **Also, on one Shiori's tap microphone:** the user says "Yes." then "No, wait." to annai's card. The card declines and nothing is granted, but the "Yes." is written after the decline and reaches Shiori as a newer line, so she may ask again. It never grants: the card is answered by tap only, and a spoken no declines.
- **Revisit when:** a user is confused by the order.
- **Approved:** 2026-11-11, the user picked "Known limitation (Recommended)"; widened to the "Yes." then "No, wait." case on 2026-11-13, the user picked "Known limitation (Recommended)".

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
- **What the user sees:** if the page closes right after a file's move, or a write fails right after it, the file is in the new trip but Shiori there has not been told to read it, and the first conversation has no "moved" line (Undo, in the first conversation, still brings the file back; it shows there at the end of a turn that carries the hand-over, under her last line of it: the one that takes it up after the close, Try again's, or the user's next). For a calendar that was waiting to be filed, its events are not planned yet either. After Open on annai's card that takes them into another trip, the same can happen when the page closes, or a write fails, between the files moving and the "moved" line in the conversation they were in: that trip doesn't open, its files are there but the user's last line and Shiori's recap are not, and the conversation may have no "moved" line. Each file moves in a write of its own, so with several files a failure partway leaves some moved and some not.
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
- **What the user sees:** the page moves to its end when the phone is turned, though the user wasn't reading its end. Three ways there: with a page scrolled to its end, something opens below with no scroll (Archived on home), then the phone turns, and the page goes past what just opened; in a browser tab, a short drag up from the end while the toolbar shows, then a turn with no other scroll; and possibly (not verified on a phone) a scroll with the iPhone's keyboard up, then a turn. A scroll in between prevents the first, and Shiori speaking or the dock changing no longer moves the page at all. The user scrolls back to where they were.
- **Why:** when the phone turns, the page is already at its new size, so whether the user was at its end can't be read then and is remembered from their last scroll. A fold opened since is not a scroll, and a scroll that arrives at a new window height before that height's resize is skipped as the browser's own. The fix changes a subtle rule about which scrolls count, and needs the WebKit turn test before it ships, for three rare sequences.
- **Revisit when:** the user meets it on the phone; the fix then: skip a scroll only while a turn's resize is still to come (the width differs), read every other one, and let the remembered fact follow the page's height, with the WebKit turn test before it ships.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries, and "Known limitation (Recommended)" for this entry, which replaces, for this case, the user's rule of 2026-11-06 that a screen jump no user would want is fixed rather than accepted as a limitation.

### Online, `nearby` takes about 35 s (27 to 52 s) for OpenStreetMap's places
- **Kind:** known limitation.
- **What the user sees:** away from an offline pack, asking what is around brings OpenStreetMap's places after about 27 to 52 s (the median is 35 s; nearby waits up to 55 s for them; Wikipedia's articles come with them, in one answer). In about 1 call in 24 every server refuses (within 3 s with VK's server off; with it on, "busy" waits for VK's refusal too, which came at 43.8 to 50.5 s in 7 of its 14), and nearby says "OpenStreetMap is busy" and gives Wikipedia's articles only, or the offline pack's places where it reaches. nearby asks overpass-api.de first, and its z. and lz4. servers only after each refuses or fails. With Settings → Tools → "Also ask VK's server (maps.mail.ru)" on, VK's server is asked as well, beside them, and its answer is used when it comes first (it answered the old query in 14 to 22 s, in 10 of 24 calls; whether it runs the `if` the new query uses is not known: the one request of the new query it was asked, at the Sydney Opera House on 2026-11-16, came back a 504 from its front server in 1.3 s, with no word about the query, as 7 of its 24 requests did on 2026-11-14).
- **Why:** the wait is the public servers' queue before a query runs, not the query: in 24 hourly probes of the lighter query from one server (2026-11-15/16, nearby's default kinds at four landmarks, in the shape probed: a 300 m circle, then a 1000 m one), replayed under the code's own rule (overpass-api.de first, the next only after a refusal or a failure, one 55 s limit), 23 of 24 calls get places, in 27.5 to 51.8 s (the median is 35.3 s), as the old query's 24 did (27.5 to 51.3 s); nearly all of it passes before the first byte (Tokyo, the first run, the probed query: the first byte at 29.3 s of 29.4 s). The one of the 24 calls that had all three servers refuse was run 4 (Sydney), in 2.4 s. nearby now asks 250, 500 and 1000 m at the defaults, one circle more than probed; its three live calls with the circles as built (2026-11-16: the Sydney Opera House at the defaults, McWay Falls at 20 km, a point in Lake Michigan at 15 km) took 32, 49 and 44 s, overpass-api.de and z. refusing the first two at once (502, "at capacity") and lz4. answering them after 31 and 48 s. The query declares 64 MiB (`maxsize`, an eighth of the default 512). By Overpass's own rule a server starts a query only while what it declares fits in half of what is free (upstream's `src/template_db/dispatcher.cc`, `Global_Resource_Planner::probe`, read 2026-11-14), so a smaller declaration may start it sooner; the probes don't show that: overpass-api.de refused the query with the declaration 6 times in 24 (each a 502 "Timeout" in about half a second) and without it 10 times (nine such 502s and one 504 after 38.6 s), too few to tell apart (Fisher p 0.36). 64 MiB did not run out at wide radii in the live calls: a 15 km circle answering 400 places, and 20 km with all 8 circles run, gave no "out of memory" remark. overpass.private.coffee and overpass.kumi.systems never answered the old query, so annai doesn't ask them. A different query doesn't shorten the wait; a shorter one needs another server: VK's, behind its switch, or one of our own.
- **Revisit when:** the first drives' Trace shows calls past 55 s, or a faster public Overpass server appears.
- **Approved:** 2026-11-16, chief's decision (the user may reverse it): "Accept as a known limitation (Recommended)", the question's option 1. Why: the wait is the public servers' queue, the lighter query the user picked ("Plan the lighter query (Recommended)", 2026-11-14) is built, and the only shorter routes are a server to host or VK's behind the switch the user set off.

### Online, `nearby` can miss a nearer place where places thicken sharply outward
- **Kind:** known limitation.
- **What the user sees:** nearby asks for circles each half the radius of the next, smallest first, each wider one only while fewer than 40 places came (250, 500 and 1000 m at the defaults), so mostly the answer is one circle whole and its nearest 40 are the true nearest 40: at the Sydney Opera House the 500 m circle came whole, 75 places, and the Opera House (an outline) is first of the 40 listed (live call, 2026-11-16). But where one circle holds fewer than 40 places and the next, four times its area, 400 or more (more than ten times as many: the ring outside more than three times as dense as the circle inside), OpenStreetMap's answer is cut at 400 in its id order, every node before any outline, so a building or a park drawn as an outline is the first to be missing. A nearer place can then be missing while a farther one is listed. The answer then ends by saying that OpenStreetMap's answer stopped at 400 places, not chosen by distance, so a nearer place may be missing, and naming a radius to ask again with: half the circle that was cut, usually the circle before it, which held fewer than 40 places and so comes whole. That gives the nearest places within it, which can be few or none; the places between it and the first answer's rows stay unknown. Shiori can ask again, at the cost of another wait for OpenStreetMap (about 35 s, the entry above); when the smallest circle was the one cut, half of it is a new circle that can be cut again and says so again. Seen live (2026-11-16): at a point in Lake Michigan 8 km off Chicago's shore, 15 km and sights, the circles up to 7500 m held fewer than 40 (none of their places is in the cut answer) and the 15 km one 400 or more, so the answer was 400 nodes with no outline, and nearby's 40 rows ran from 7.6 to 9.9 km. A car coming to a city across open country, with the driving companion's 5 to 15 km look ahead, would meet the same (not seen on a drive). With the earlier step of 0.3 of the radius the cut came at the Sydney Opera House, where its 300 m circle held fewer than 40 and its 1000 m one 400 or more: all 10 saved answers of that query there are the same 400 nodes, none an outline, the Opera House not among them. A smallest circle (151 to 300 m for a radius over 300 m) that itself holds 400 or more would be cut the same; it was not seen: the densest saved one held 153 (Paris, 300 m).
- **Why:** Overpass can't sort by distance, so the nearest places are asked for as widening circles in one request, and its answer is capped at 400 (ten times the 40 kept), which bounds the download and cuts in id order. A smaller step between circles makes such cuts rarer and the query longer and slower to run (8 circles at 20 km, up to about 9.4 KB with every kind, at half the radius each; more at a finer step). nearby says when its answer was cut: when Overpass's answer holds 400 elements (counted as Overpass sent them, not as the rows nearby keeps), nearby's answer ends with that line, after the line saying the offline pack filled in for Wikipedia where it did. It names the circle to ask again with from the places that came: the first of the query's circles that holds 40 of them, by the distance each carries (an outline's is to its centre, so it can name a smaller circle than the one cut, still whole; or, rarely, a larger one, when an inner circle was cut, holding fewer than 40 nodes, and about 360 outlines touch it but are centred beyond it: the retry is then cut again, says so, and names a smaller circle), halved. Half the radius asked would not do: the query stops at the first circle holding 40 or more, so the circle cut is the widest only when no smaller one held 40; when an inner circle was cut, a query for half the radius is the query that already ran, and gives the same cut answer, another wait for nothing.
- **Revisit when:** a place known to be near is missing from a list in use, or the log shows cut answers on drives.
- **Approved:** 2026-11-16, chief's decision (the user may reverse it): "Accept, and nearby says when its answer was cut (Recommended)", the question's option 1; the follow-up ships in the next release and never holds stage 8. It narrows the user's "a lighter, nearest-first query" (2026-11-14) where places thicken sharply outward.

### An answer Shiori already gave can be said once more
- **Kind:** known limitation.
- **What the user sees:** Shiori says again something she has already told them, in two rare ways. With her two halves, Koe (who talks) asks Kokoro (who thinks) again something she has already answered, and the user opens another conversation in the moment before Kokoro is idle (usually a few milliseconds as her turn ends): on coming back, Kokoro takes Koe's question up and may give the old answer again, which Koe says. And when annai is reloaded or killed while she is speaking, or in the few milliseconds between her last tool result or reply in words and the record the loop then writes that her turn ended (measured 0 to 37 ms in Chromium and 1 to 25 ms in WebKit), the turn is taken up the next time that conversation opens, as before this release, and she may say that line again. With her two halves, when Kokoro took that restart up (or Koe was live then), Koe's own turn stays unfinished until Koe next has a turn: a later open, with Kokoro owing nothing and Koe on a chat model, can have Koe take it up and say its answer once more, possibly much later.
- **Why:** that Kokoro has already answered is written down only once she is idle, because that record settles everything before it; written sooner, it would also settle what she still owes (a line typed meanwhile, a turn the open cut). A record that names only the questions it settles would close the gap, as a new stored shape. The record of a turn's end is written after her last result, not with it, so a turn killed in between reads as under way. After a kill annai can't tell what ran (a line cut in its playback, a call after it that never ran), and not taking the turn up would lose a second sentence, or a reminder she had just announced. Koe's log has no end for a turn cut in its reply, and writing one where the restart is declined would settle the turn but not what Koe still owes.
- **Revisit when:** the user hears an answer repeated after coming back to a conversation or after a reload, or what a conversation still owes comes to be recorded line by line for another reason; or a repeat shows up in the Trace.
- **Approved:** 2026-11-10, the user picked "Accept as known limitation". The later open after a restart Kokoro or live Koe took: 2026-11-14, the user picked "Accept, widen the entry (Recommended)". The moment between her last tool result and the record of her turn's end: 2026-11-14, the user picked "Widen the entry (Recommended)".

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

### Opening another conversation can take up a turn she has already answered
- **Kind:** known limitation.
- **What the user sees:** a rare case when the user opens another conversation while Shiori works on something they asked, after she has already answered them: the open comes while a later step of the same turn writes her notes, or during a tool that follows her answer in the same reply (she says something, runs a tool, and has more to say after it, with or without a `sleep`). The conversation left says "Shiori was in the middle of something. She picks it up when you come back.", and on coming back she takes the turn up, an extra turn that may say her answer again. (Narrowed 2026-11-14, with the ask-owed fix: until then a reply that said something, ran a tool and slept lost the rest when the open came during the tool, and was not taken up on return either, with no "picks it up" line; it is now taken up as the same reply without a `sleep` already was. A call cut by the open counts as a failed one, so the sleep beside it doesn't end her turn. A reply that asks a question, takes the user's answer, goes on to work and then sleeps is taken up the same way.)
- **Why:** whether a cut turn still owes the user is decided where the loop ends it. A turn cut at its work has no end record and is taken up, whatever reached the user before; one whose last step talked to them or waited on them is let go. Telling a later step's notes from the work after the user's answer needs the loop to know whether the user's words came after her last line to them, and a repeat loses nothing, where the dropped rest did.
- **Revisit when:** the user hears a reply repeated this way and minds it; the fix then: the loop's let-go decision (`#lettingGo`, `#cutWaiting`) knows whether the user's words came after her last line to them, to be chosen first.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries.

### A reminder set across a change of summer time can come an hour off what she said
- **Kind:** known limitation.
- **What the user sees:** the user asks for a reminder on a date after the clocks change (in November, for March 19, say), and Shiori writes it with today's offset instead of that date's (-08:00 where March 19 is -07:00). Both her halves then say the time as written, "6 PM", and the reminder comes at 7 PM local time. Before this release Koe gave the time in the phone's zone, which showed the mistake, if confusingly. It needs the model to get the offset wrong, and in the real checks it didn't: in the first one the model got it right, and on 2026-11-13 Opus 5.5 and Sonnet 5.5 wrote the summer offset unprompted 11 of 11 times, and corrected a scripted winter offset themselves 8 of 8.
- **Why:** both halves now read one set of words for a reminder's time, made from the offset she wrote, and nothing checks that offset against the zone's on that date. A warning keyed on the phone's zone's offset (built and taken out the same day) gave wrong advice for right times in a trip's zone that shares the phone's offset today (Lisbon in July, from Berlin), and the real check showed no gain from it.
- **Revisit when:** a model annai runs (Haiku as Shiori or Koe, a local model) is seen writing the winter offset unprompted, or a user gets a reminder an hour off. The fix then: when the written offset doesn't match the conversation's zone at that moment, setting the reminder gives her the time in that zone too, so she sees her own mistake; it needs a real run on a shared-offset shape first (Lisbon from Berlin, Chicago from New York).
- **Approved:** 2026-11-13, the user picked "Known limitation (Recommended)" for this entry, after it was taken out of Build C.

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
- **What the user sees:** a plan item shorter than 30 minutes that starts on one day and ends on the next, in its own time zone (23:55 to 00:09, say), keeps showing on the conversation's "Next:" line after it is over: its start for up to 30 minutes after it began, then "Ends · <item>" until 30 minutes after its end. Then the line moves on or hides. Items within one day hide at their end. The same rows feed Drive's strip and the timeline card's Next (and fed Now until timeline stage 8).
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

### Live Koe's tool calls in flight when another conversation opens are written into the conversation opened
- **Kind:** known limitation.
- **What the user sees:** in live voice, one of Koe's tool calls is still running (or its first write is waiting behind the other conversation's opening) when the user opens another conversation. The call is written in the conversation left, but its result lands in the conversation opened, as a result with no call, and the conversation left keeps a call with no result. When the call is Koe's `tell_kokoro`, the note itself lands in the conversation opened and wakes Kokoro there, which answers a question about the trip left, in the trip opened. Koe's spoken and heard lines are not affected: they are written where she spoke. (Reproduced on the test stand-in with a tool held while the switch ran; the version before this one did the same.) The other way round too: a note of Kokoro's to Koe whose log write is still in flight when the user opens another conversation (milliseconds after their tap) is logged in the conversation left and said in the one opened, so Kokoro's answer about the trip left is said in the trip opened (found by reading, in Build B's review; `Channel.send` awaits Kokoro's log write, then Koe's queue takes the conversation that is open by then).
- **Why:** a call's writes (`tool.call`, `tool.result`, and the note through the channel) go into whichever conversation is open when they are written, and the switch changes it meanwhile; the note's delivery wakes Kokoro in the open conversation. Binding the writes to the session's conversation, as her lines are, is a small change (pass it from the session's call through `liveCall` into `#runCall`), but it leaves what the note for a conversation no longer open should do (not wake Kokoro there; be kept for when the user comes back, or dropped), and a call that starts after the switch, which runs against the conversation opened. Those are decisions, not a pass-through, for a switch while one of Koe's calls runs.
- **Revisit when:** it happens to the user; the fix then: the session's conversation is bound to its calls' writes, after deciding what a note to Kokoro for a conversation that is no longer open does, and what a call that starts after the switch does.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries. Kokoro's note in flight added on 2026-11-13, the user picked "Add to known limitation (Recommended)".

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

### Kokoro's words owed at a switch may be shown, then said again on coming back
- **Kind:** known limitation.
- **What the user sees:** with her two halves, Koe still owes Kokoro's words when the user opens another conversation. The words are shown in the conversation left (before this release they were sometimes lost). Coming back, Koe may take its cut turn up and say them again: shown, then said once more (8 of 32 runs under a real clock in Build B's check).
- **Why:** the switch hands Koe's owed notes to the conversation left, as Start fresh does, but Koe's own log doesn't mark them said, so its turn taken up again may still say them. Marking them read in Koe's log at the switch is more state for a double that loses nothing; a double beats a loss.
- **Revisit when:** the user notices a note said twice after coming back.
- **Approved:** 2026-11-13, the user picked "Known limitation (Recommended)".

### The quick gate takes passengers' talk for Shiori's when it is unsure
- **Kind:** known limitation.
- **What the user sees:** with passengers talking to each other without naming Shiori, annai's quick gate (which decides whether a heard line is meant for her) judged their talk meant for her 10 of 32 times (passengers who name each other 4 of 66, talk radio 2 of 81, the user's own lines 13 of 13 for her), and she once answered a passenger's remark. A wrong verdict is also quoted to the next gate call as the user's line, which leans the next verdict the same way.
- **Why:** the gate's rule is "when unsure, it is for her" (`src/core/voice/gate.js`), so a line meant for her is never dropped; the cost is the occasional answer to talk not meant for her.
- **Revisit when:** the user drives with passengers often and she answers them; the change then: the gate's verdicts are quoted to the next gate call as heard, not as the user's words.
- **Approved:** 2026-11-13, the user picked "Known limitation (Recommended)".

### A tap on an older card's "Yes" answers her newest yes/no question
- **Kind:** known limitation.
- **What the user sees:** Shiori showed a card with choices earlier, and has just asked a new yes/no question; the user taps "Yes" on the older card. The choice reaches her as bare words, so she takes it as the yes to her new question. It never grants annai's own permission card, which only a tap on itself answers.
- **Why:** a tapped choice reaches her as the words of the choice, without naming the card it came from; the shape needs an old card still on screen and a new question with the same words.
- **Revisit when:** the user sees it; the change then: a card's choice names its card in what she reads.
- **Approved:** 2026-11-13, the user picked "Known limitation (Recommended)".

### Koe on a chat model can show "Shiori didn't answer" for a line it answers a moment later
- **Kind:** known limitation.
- **What the user sees:** with Koe on a chat model, in a rare turn shape (Koe's one reminder to answer already used, then a reply with a wait plus sleep, while the user types a line), a warning card ("Her model finished without saying anything to you", with Try again) shows, then Koe answers the line in the next turn. Nothing is lost; before this release the line was never answered. A reply with a question plus sleep no longer has this shape (narrowed 2026-11-14, with the ask-sleep fix, which keeps the turn going when her question comes back: one turn takes the line, and no card shows).
- **Why:** the sleep in the same reply ends the turn before the queued line is taken, so the line gets a turn of its own, and the turn just ended counts as silent. Skipping the card while a line of the user's is still queued is a one-condition change, for a shape seen only in a probe.
- **Revisit when:** the user sees the card followed by an answer; the fix then: no such card while a line of theirs is still queued.
- **Approved:** 2026-11-13, the user picked "Known limitation (Recommended)".

### Koe on a chat model can say her question over the user after they cut her line
- **Kind:** known limitation.
- **What the user sees:** with Koe on a chat model, the user taps to cut her line and starts talking; her reply goes on with a note to Kokoro and then a question (or any reply with a question and sleep), and the question is said over them. Their words aren't lost: they are taken after it.
- **Why:** the rule that holds her question back after a cut looks only at the call right after her line; finding "a question before any wait" anywhere in the reply is a wider change for two rare shapes.
- **Revisit when:** the user hears it; the fix then: look for a question before any wait in the reply, not only the next call.
- **Approved:** 2026-11-13, the user picked "Known limitation (Recommended)".

### With live voice, a reminder can't be set while Kokoro can't answer
- **Kind:** known limitation.
- **What the user sees:** with Koe on live voice (Gemini Live, OpenAI Realtime), the user asks for a reminder while every model in Kokoro's list is failing or resting but the live voice still answers. Koe tells them to hold on, passes it on, then says it couldn't check and offers to try again; no reminder is set. They can ask again once Kokoro answers, or type it with voice off.
- **Why:** a live Koe is told the time only when its session opens, so it no longer sets reminders itself: Kokoro sets them from its own clock, to the second (the user's pick 2026-11-13, "Live Koe hands off"). Giving Koe a way round would bring back the part that set reminders from an old clock; every other ask of Kokoro fails the same way in that state.
- **Revisit when:** a user meets it, or traces show Kokoro down while live voice works.
- **Approved:** 2026-11-13, the user picked "Known limitation (Recommended)".

### With live voice, Koe can say the reminder list twice
- **Kind:** known limitation.
- **What the user sees:** with Koe on live voice, the user asks "What reminders do I have?"; Koe answers from its own list, then Kokoro wakes because Koe answered the user, checks the list again and sends a note, and Koe says the same list a second time (2 of 2 runs on real Gemini Live, 2026-11-13). Nothing is wrong or lost.
- **Why:** Kokoro's wake after Koe answers lets it add what Koe may have missed; telling which of Koe's answers came whole from its own tool is more state, for a double that loses nothing (a double over a loss).
- **Revisit when:** the user finds the repeat annoying.
- **Approved:** 2026-11-13, the user picked "Known limitation (Recommended)".

### A line typed into her `wait` is not asked again when her reply shows nothing
- **Kind:** deferred.
- **What the user sees:** voice off, with no question card up. Shiori says "Which day?" and waits (`speak` then `wait`), and the user types "Friday". Her reply is plain text only or a bare `sleep`: nothing is shown, she is not asked again, and no "Shiori didn't answer" card shows. (The same line typed to Koe's own `wait` is owed, as is a typed line that comes while she works. An answer to her question card is owed since 2026-11-14.)
- **Why:** the ask-owed fix marks only an answer to her question card; a word said into her `wait` or the window after her line "may be no one's" (spec §7.1), and voice tests pin a bare `sleep` after a heard word with no cue. That reason does not hold for typed text: marking only what was typed leaves every heard word as it is.
- **Revisit when:** the next version, as its own change: one line in `#answer`'s typed branch (`#facts.answeredAt = this.#reached`), a test from the final review's probe g (the `wait` shape), the spec's §7.1 clause, and a look at the next real run. Tried in a scratch copy: the unit suite passed 5109 of 5109 with no test changed.

### Turns the version before this update left unfinished are read as finished
- **Kind:** known limitation.
- **What the user sees:** once per update, and only in a conversation where it happened, in a turn of hers the previous version left unfinished when the update installed: (a) a turn left paused by opening another conversation ("She picks it up when you come back") and not yet returned to is not picked up, and they ask again; (b) the same for a turn annai closed after her calls had come back or during her next model call (no "picks it up" line there); (c) a hand-over in such a turn reads as answered, so what she files when they ask again is outside its Undo; (d) a turn killed while her calls were still running is picked up, but what she files in it is outside the hand-over's Undo; (e) Try again on a "Shiori didn't answer" card, or a model-failure card, left from before the update carries no hand-over, so what she files is outside its Undo. Undo never takes back too much here: it leaves a file, which can be deleted by hand. A line of theirs she never replied to is still answered.
- **Why:** this version logs a record where her turn ends and reads her turn's end only from it. A log the previous version wrote has none, so each of its replies is read as the end of its turn. Reading those replies by the old rules too would keep the word-reading this change removes, in the same function.
- **Revisit when:** a user reports a "She picks it up when you come back" line that was never picked up after an update, or an Undo after the update that left a file.
- **Approved:** 2026-11-14, the user picked "Treat as finished (Recommended)" for old logs, and "Approve the wider entry (Recommended)" for this entry with all five effects.

### Tool results still carry `end` and `awake`, which this version doesn't read
- **Kind:** deferred.
- **What the user sees:** nothing. Each tool result still stores `end: true` (her line's listening heard chatter) and, for a sleep that gave way, `awake: true` (also stamped by a restart's repair), as the version before this one reads them; this version reads her turn's end from its `turn.end` record.
- **Why:** a page one version older (a rollback, a tab not yet updated) reads her turn's end from them, and would misread a newer log without them.
- **Revisit when:** the next version, as its own change: drop `end` and `awake` from `#runCall`'s and `repair()`'s writes, and from the tests that pin them.

### The restart of a turn annai started carries a hand-over still owed by an older failed turn
- **Kind:** deferred.
- **What the user sees:** the user hands Shiori a file, her turn fails ("Shiori can't reach her model") and they don't tap Try again. Later a turn annai starts by itself in that conversation (a watch or a reminder firing, a plugin's wake) is cut by a reload or a kill, or a wake written while the conversation was closed is taken up when it opens. The turn that takes it up carries the old hand-over, so what she files for the watch counts as filed under that hand-over, and tapping its Undo takes that note back too. It needs a failed hand-over left alone, a turn of annai's own, a cut, a write, and then the Undo. Found on 2026-11-14 in the final review of the turn-end record; the same on the version before it (run on both).
- **Why:** the restart wake takes the reader's `handover`, the newest hand-over no turn's end has answered, whoever's turn was cut; `#open` passes it on without asking whose turn it was.
- **Revisit when:** the next version, as its own change, in the reader's `handover` getter and `#open`: each reply's record already stores the hand-over its turn carried, so a turn under way can hand back its own, not the conversation's newest owed one; then a test of this shape.

### The real-voice check measures Koe's words in English
- **Kind:** deferred.
- **What the user sees:** nothing. Three checks in `scripts/realtime/` read Koe's words as English: "stopped when told" counts words by spaces, so a long Japanese reply passes; the passed-on question test sees only an ASCII "?", so 「？」 passes; the filler check knows English words only.
- **Why:** found on 2026-11-14 while checking Koe's new pass-on words in Japanese; each check predates that change and none is in the app.
- **Revisit when:** the next version: count CJK by character as the recall check already does, accept 「？」, and give the filler check its Japanese and Chinese words (with a recorded Japanese clip to test them).

### Shiori's written recap gets no native-speaker sentence
- **Kind:** deferred.
- **What the user sees:** a recap written in Japanese or Chinese may still read translated: its request names the language but carries no sentence on how it should sound, unlike her answers since 2026-11-14.
- **Why:** no real run has written a recap in Japanese, so whether it reads translated is not known.
- **Revisit when:** the next version: run one real Japanese recap; if it reads translated, add the Languages section's native-speaker sentence to the recap's request.

### Summaries pick their language two different ways when no words decide it
- **Kind:** deferred.
- **What the user sees:** nothing on screen today: with nothing chosen in Settings → Languages, compaction and Shiori's own answers fall back to the phone's language (one rule since timeline stage 7), and the recap to the screens' language; with languages chosen, all three take the first listed. Compaction also counts annai's "(files)" placeholder as words the user wrote.
- **Why:** each rule was written for its own place; one answer to one question belongs in one place (RULES #10).
- **Revisit when:** the next version: one shared function for "the language the user wrote in", used by compaction and the recap, with annai's placeholders left out everywhere.

### A live Koe's line before a tool has no language rule
- **Kind:** deferred.
- **What the user sees:** possibly, with live voice in Japanese, a word in English before Koe looks something up. Not seen: no live run has exercised that line in Japanese.
- **Why:** Koe's pass-on and okay words name the answer's language since 2026-11-14; the pre-tool line (koe/instructions.js) was left as it was.
- **Revisit when:** the next version: describe it the same way, then one live run in Japanese.

### Kokoro can write its notes to Koe in English in a Japanese conversation
- **Kind:** deferred.
- **What the user sees:** with Koe and Kokoro, Koe's Japanese can come out stiff when Kokoro's note to it was English ("Tell the user in Japanese: …"), seen once in a live run on 2026-11-14.
- **Why:** nothing tells Kokoro which language its notes to Koe are in.
- **Revisit when:** the next version: say it in the note tool's description or the halves' text, then a live run in Japanese.

### Her reply to the "you haven't answered" cue can still be private text
- **Kind:** deferred.
- **What the user sees:** after answering her question card, if her reply showed nothing and the cue followed, in about 1 of 9 forced runs she answered again in plain text the user never sees, and "Shiori didn't answer" showed.
- **Why:** the cue says only speak, show and ask reach the user; a model can still write plain text.
- **Revisit when:** the next version: firmer cue words, measured on the ask-owed run's forced set.

### Testing docs and specs still name the Koe lists "Realtime" and "Classic", and a menu "Tidy up"
- **Kind:** deferred.
- **What the user sees:** nothing on a screen. A tester following the testing docs looks for names the screens no longer show: "Koe · Realtime" (realtime-check.md:32), "Koe · Classic" (reasoning-check.md:15), and the bare "Realtime" and "Classic" of the device checklists (device-checklist-koe.md, device-checklist-phase2.md, device-check-plan.md), where the screens say "Koe · Live" and "Koe · Chat". Some specs name a "Tidy up" menu: the Conversation screen's ⋯ menu ("Conversation menu") has "Summarize now" and "Start fresh" in it, and no "Tidy up".
- **Why:** found on 2026-11-14 while correcting the words Shiori is told. The checklists and dated specs record what was true when they were written; renaming every mention is a doc-only change of its own, and a rename that misses a step is worse than a name the tester can guess.
- **Revisit when:** the next version: rename in the testing docs (the checklists a tester follows) and leave the dated specs as they were, with a note at the top of each spec that names the new words.

### Some plugin errors still start in lower case with no subject
- **Kind:** deferred.
- **What the user sees:** a card or an install screen's line such as "is being removed", "is switched off after repeated errors", "couldn't be downloaded. Check the connection and try again." or "didn't provide a kind of backup place X", with nothing before it but the plugin's name. Where a line has a translation (its `shown`), only an English screen reads the fragment; a Japanese or Chinese screen shows its own draft, which reads as a sentence. The lines with no translation (a plugin author's manifest errors, marked lang="en") read as fragments on every screen.
- **Why:** found on 2026-11-14 with the others. The lines below are what a search found still in lower case that day; that is not a claim that every other line is right. With a translation: src/core/plugins.js:438, :607, :609; registry.js:221; package-updates.js:54, :58, :62; llm/official.js:156, :158, :160, :296, :298; llm/service.js:346. With none: src/core/packages.js:82, :84, :87, :90, :93, :95, :98, :99, :363, :398, :402, :404, :406, :411, :414, :420, :422, :428, :430 (19 lines). Other lines in plugins.js (from :693), requires.js (:52) and pdf-pages.js (:36) also begin in lower case and were not checked screen by screen. The lines the pass did fix begin with "It …" or a name (requires.js's "It needs …", plugins.js:179-190 and :439, packages.js:336-348 and :366, service.js:248-266 and :337, official.js:273 and :275).
- **Revisit when:** the next English change: the same fix, "It …" or the name, with the log's English unchanged. A changed line gets new drafts in Japanese, zh-Hans and zh-Hant in the same commit, because its key changes with its English.

### A few words from the 2026-11-14 translation pass still need a second look
- **Kind:** deferred.
- **What the user sees:** in Chinese, the install screen's "came from a file" reads 来自 1 个文件, a count where none is meant (the row "a file", 8w8k36, also fills a toast); the same English "the browser's own dictation and voice" has two drafts in each language (読み上げ / 朗读 in one row, 声 / 声音 in two others), next to the Roles list's "Phone dictation"; "a plan's 'leave soon'" is the one place a screen says "plan" where the rest says "the itinerary's"; one zh-Hans search line has two 它 for different things; the backups intro's "after changes or once a day" doesn't hold for a place whose automatic backup is Off, and it no longer says which connections backups use (each place's page does).
- **Why:** each was found by the review after the English fix's second round; none is a wrong result or a false privacy line.
- **Revisit when:** the next English and language change: whole sentences for "a file" and the calendar toast (or a context at plugin-install.js:189), one name for dictation everywhere, "the itinerary's 'leave soon'", the backups intro naming Wi-Fi and the per-place rule.

### Photo encoder plugins
- **Kind:** deferred.
- **What the user sees:** a model that takes photos only in a format this browser can't make (AVIF or JPEG XL anywhere, WebP on an iPhone) is sent the photo and refuses it: the next model in the role's list is then tried, and a card says "This model takes photos only as AVIF, which this browser can't make. Try another model in Settings → Models." On an iPhone, photos go as JPEG (or PNG when a model asks for it), since Safari writes no WebP (Settings → Photos says so).
- **Why:** the user asked on 2026-10-15 and 10-16 for plugins that add the encoders a browser lacks ("only for the encoders the browser does not have, we supply a way to add that"); they were pushed out of the photo plans (m1b, m2c) and never built. They need a plugin kind for encoders (docs/plugins.md has none), `'wasm-unsafe-eval'` in the page's security policy (`_headers`, spec §15) and a first plugin (WebP for Safari): a build of its own, as is the card that finds one in the catalog when a model refuses a format (spec §9.9). The spec's design for them stays (§4.8 "Encoders", §9.9, §15, §20), each marked later.
- **Revisit when:** the build after the interface redesign.
- **Approved:** 2026-11-14, the user picked "Later build; fix the card now (Recommended)".

### Old place, activity and "every" watches set in the no-trip conversation are never looked at again
- **Kind:** known limitation.
- **What the user sees:** a place, activity or "every" watch that Shiori set in the old conversation outside any trip, before timeline stage 7, no longer fires, and no screen lists or cancels it (watch_list and watch_cancel are per conversation, and no turn runs in `me` any more). Time reminders set there still fire: annai says the reminder and logs the wake in `me`'s log (src/core/live/live.js `#looked` looks at a `time` watch in any conversation). Only someone with such a watch still pending at the update sees it.
- **Why:** before stage 7 those watches fired only while the no-trip conversation was open. `me` is never open now, so looking at them takes a new rule in live mode, for a set of watches that can't grow (none can be set there any more).
- **Revisit when:** one turns up in the Trace, or the user misses one (the user: "Revisit if one turns up in the Trace or you miss one").
- **Approved:** 2026-11-14, the user's pick "Known limitation (Recommended)", on the final review of timeline stage 7.

### annai's photos can outlive 48 hours at OpenRouter
- **Kind:** known limitation.
- **What the user sees:** files named `annai-….webp` (or `.jpg`, or `annai-test.png`) in the OpenRouter workspace's files after their 48 hours, whenever annai can't delete them: until annai next starts, comes online, or makes its daily check while it is open (an annai left open and online for days deletes once a day); for good, if this phone's annai data is lost and no annai signs in to that workspace again; for good, if OpenRouter is removed, its key or address changed or Erase used while annai can't reach OpenRouter; for good, if Erase reaches OpenRouter but has more uploads from the last 48 hours than the 10 seconds it waits can delete (about 140, at the 427 ms a deletion took when measured, six at a time; fewer on a slow connection): the rest stay, as the page reloads with the key gone; for good, after Sign in again into another workspace; and for good, if OpenRouter changes its beta files list so annai can't read it (uploads then stop too, so no more are made). A photo whose upload was still on its way as a new key or address was saved, and was answered only after annai finished the change, stays for good when the new key belongs to another workspace (with the same workspace it goes at 48 hours as usual). An older annai running the new plugins before it restarts into its new version uploads with no sweep, and files from a removal, Erase, a key into another workspace (Sign in again or typed) or an address change made in that window stay for good. And for good, while OpenRouter's key is kept outside its key field (only in Extra headers, or added by a server of one's own at its address): annai's sweeps use the key it keeps, so they skip it, though Test says annai deletes them.
- **Why:** OpenRouter keeps uploads until they are deleted and its upload takes no expiry, so only annai can delete them, and only while it runs with a key to that workspace. Anything more would need a server annai doesn't have. annai deletes from OpenRouter's own list (spec §4.8), so any annai signed in to that workspace later deletes what is left.
- **Revisit when:** OpenRouter adds an expiry to uploads (annai would set 48 hours, as it does at OpenAI).
- **Approved:** 2026-11-14, the user's pick "Accept it (Recommended)" on the OpenRouter uploads plan's question "annai's photos can outlive 48 hours at OpenRouter". Widened 2026-11-14 by the user's pick "Widen the words (Recommended)": the Erase with more uploads than its 10 seconds can delete. Widened 2026-11-15, the user's pick "Accept it (Recommended)" (the late upload, an address change); 2026-11-15, chief's decision (the older-core window). Widened 2026-11-15, chief's decision C43 (the key kept outside its key field; the older-core clause's "a key into another workspace (Sign in again or typed)" confirmed).

### An old flight's place, and six of a booking's details, aren't named the same way on screen and by Shiori
- **Kind:** deferred.
- **What the user sees:** a booking saved before 2026-10-29 and never confirmed is read as one with every part marked (2026-11-16). For a flight that has a `place`, Shiori and Koe ask about "the place", but the flight's details draw no Place line, so the user can't find it on screen (the Plan's "Check N details" counts what the details draw, so it doesn't count it). And a flight's terminal, gate, bags or travellers, a train, or a car, each labelled on the details screen, is "some other detail" in what Shiori is told, so she can't name it.
- **Why:** the details' list of a flight's lines (`ORDER.flight`, src/ui/format.js) has no `place`, and Shiori's word table for a booking's parts (`PARTS`, src/core/bookings.js) lacks six keys the screen's labels (`FIELD_WORDS`) have; both are older than the old-booking round, which made them routine on old flights. Found by its re-review (2026-11-16), too late to change Shiori's words before the release without a real-model run.
- **Revisit when:** the next version: add `place` to a flight's lines (the function's own comment promises nothing she wrote goes unseen), give the six keys Shiori's words with a unit test that both tables cover the same keys, and run one real-model cell.

### OpenAI's and Groq's speech models name their provider twice, and two same-named providers look alike
- **Kind:** deferred.
- **What the user sees:** since 2026-11-16 every model is named after its provider ("OpenRouter / Anthropic: Claude Opus 5.5"). OpenAI's and Groq's speech models already carried their provider's name in their own names, so they read "OpenAI / OpenAI: GPT Transcribe" and "Groq / Groq: Whisper large v3 turbo" in Speech in and out, their pickers, the Voice tests and the Trace. And a provider added twice from one plugin without a rename (two OpenRouter keys) is "OpenRouter" both times: its models differ only by "(2)", and Settings → Tools lists both records' models in one row.
- **Why:** the hand-made prefix in those two descriptions answered the same problem before the general rule existed; dropping it renames models, and a description update renames a model without checking that the name is free (`syncProviders`, src/core/llm/providers.js), so that check comes with it. A second provider's default name is the plugin's.
- **Revisit when:** the next version: drop "OpenAI: " and "Groq: " from those names with the free-name check at `syncProviders` (then `modelNames`' guard for a name two providers claim can go), and give a second provider of one plugin a default name with "(2)", as its models get.

### A leave reminder shows before annai records the arrival when annai's first fix back on screen is slow or imprecise
- **Kind:** deferred.
- **What the user sees:** the phone locks on the way to a fixed item, and the traveller arrives while annai is off screen. When annai comes back on screen with live mode on and GPS on and allowed, its catch-up waits up to 15 s for the first fix (`FIX_WAIT_MS`, src/core/live/live.js; with live mode or GPS off it ends at once). With a fix at the place (within the item's arrival radius, 300 m or a flight's 2 km, and itself that accurate) inside that time, the catch-up says only "Nepenthe: Lunch at Nepenthe." and leaves out the item's leave line (leave-next). With a slower fix (a poor signal, a cold GPS) the catch-up ends at 15 s; with a first fix less accurate than that, or off the place, it ends with that fix. Either way it says "Leave soon: Lunch at Nepenthe at 12:00." to a traveller who is already there, and the arrival comes in a wake of its own a couple of minutes later, once annai has seen them stay: both lines, as before leave-next.
- **Why:** the arrival can't be known before a fix, and the catch-up ends with the first fix or after 15 s, whichever comes first. Holding a timer-ended catch-up's leave line for a later fix would lose it when no fix ever comes. How often a real phone's first fix beats 15 s is not measured.
- **Revisit when:** after the trip, with the trace's first-fix times and accuracies after annai is back on screen: if many come after 15 s, hold a timer-ended catch-up's leave line for the fix, or leave it out of the arrival's wake.

### The Undo line misses what a turn writes that took the hand-over up partway and then fails or is stopped
- **Kind:** deferred.
- **What the user sees:** a hand-over's turn failed and is still owed. Later a reminder's turn (or Kokoro's cue turn) is running when the user types; the loop makes that turn carry the owed hand-over from there, and what she writes in it is filed under it, so Undo takes it back. When that turn ends, the Undo line shows under its last line (its `turn.end` names the hand-over; tested). But when it fails (a card), ends silent, or is stopped after the write, no record names the hand-over (its wake named none, and an error has no `handover` key), so the line is not looked at again then: it stays where it was, hidden if nothing was written before it (under the first turn's card). It shows once the conversation is drawn again (back from another screen, or a reload: the first turn's card then finds the write, and the line shows under that card), or with the user's next line, whose turn carries the hand-over still owed (under her next line, or where that turn ends). It needs a failed hand-over, a turn of annai's own running as the user types, then a failure or a Stop after her write. Found in the final review of the Undo line's placement (2026-11-16, its finding U2, the builder's finding 3). The same goes for a hand-over that joins her running turn when that turn then takes the user to another trip (open_trip, the user taps Open): the turn is let go (`error` `left`, no hand-over named, written before the conversation.moved line), so the line stays under annai's card, above "Open", "Shiori took 1 file to Kyoto." and "Shiori moved this to Kyoto." (seen with the real loop in undo-f1's fix round, 2026-11-17).
- **Why:** the two records that end such a turn without a `turn.end` don't say which hand-over the turn carried, and no new record shape is worth adding for a case this rare (the build's wake-for-the-join record was left out for the same reason).
- **The same cause, two halves (undo-f1's re-review, R1):** with Koe talking, when a running turn of Kokoro's takes a hand-over up partway and either a reminder's turn takes up an owed hand-over or the user says anything while Kokoro works on it, the Undo line ends one row above Koe's last words or a card of Kokoro's (between "Shiori took 1 file to Kyoto." and "I took it to Kyoto."). It still shows and Undo works; one Shiori is fine. Older than undo-f1, which made it better.
- **Revisit when:** the next version, after a design check of the Undo line's placement by a fresh agent (RULES, "Step back when findings repeat": every round of undo-card and undo-f1 landed in the partway end and `turn.node`); the candidate is one record the loop writes at the take-up (it knows there, loop.js `#handover`), which may let `turn.node`, its reset and the partway branch go and cover every shape here, instead of `handover` stamped on the error records of `#failed`, the silent card, the Stop and the let-go one (`left`).

### A few unit tests still race a host loaded far past its CPUs: the live kit's short quiet spell and plugin-web's scaled deadlines
- **Kind:** deferred.
- **What the user sees:** nothing in annai. For whoever runs `npm run check` on a host loaded far past its CPUs (load about 300 on 32 CPUs, or event-loop stalls of 200 to 400 ms), a few unit tests can still fail on their own timing and pass when run again: plugin-web's two deadline tests ("S10: a search ends by its deadline…", and "ready() is charged to the search's deadline"; S10 failed once in a real check at load about 300), and tests on the live kit's default quiet spell of 300 ms (its 10 ms second), such as live-koe-review's item 13 and item 3 (probe E2), seen failing only under a stall probe. gate-load (2026-11-17) fixed the ones that failed at the host's usual heavy load (130 to 250).
- **Why:** test timing, not the product: a scaled clock makes a session's spells and a search's deadline a fraction of real time while the work around them takes real time.
- **Revisit when:** the next version: the live kit's default quiet spell made long (`closeAfterSeconds: 300` in koe-live-kit.js's `liveKit`; tried on the 776 tests of the 23 files that use the kit, all pass and the files' time is unchanged; 92 tests already set it by hand), and plugin-web's scaled deadline and reserve in seconds, with bounds to match.

### A delayed flight, or one with no arrival time, lets the next item's reminders fire in the air
- **Kind:** deferred.
- **What the traveller sees:** what comes after a flight (or a train or ride) waits for its end on the plan, else its start (leave-far, 2026-11-16). A plane that lands late, or a flight item with no end, lets the next fixed item's "Leave soon" and "Running late" come while the traveller is still in the air (with a position within 1000 km of the item, "Running late: … About N min away" with a big N). The push relay's copy waits only for the flight's end, else its start: a flight at 14:00 with no end and a car pick-up at 16:20 give a copy due 15:50 with no position (14:00 when annai last saw the traveller at a departure airport within a day's drive), while the plane may still be in the air. A second flight after a flight item with no end is not read as its connection, which would get neither: the first is taken to land when it departs, so the second gets its own "Leave soon" and "Running late" from the first's start, as before leave-next, at the first's departure airport (at the gate, or delayed on the ground) or in the air: "Running late: Flight AB 2 departs 11:30, Schiphol. About 403 min away." for a first flight at 08:00 from Heathrow.
- **Why:** annai doesn't know where the plane is; the plan's time is all it has. The plan-a-trip skill expects a flight's end ("A flight starts in the departure airport's zone and ends in the arrival's") but doesn't ask for one, and its bookings line names only "a flight's departure" (skills/plan-a-trip/SKILL.md:27); how often a flight item has no end is not measured. Counting the wait from the first stop annai sees after the flight is not built (the design check, 2026-11-17): it would hold back true reminders whenever annai sees no stop after the landing, and the relay can't see a stop while annai is closed. Taking the linked booking's end for a flight item with none was built in leave-next and taken out in its fix round: a booking's end is often a return's, a tour's or a stay's, not this flight's arrival, and it took away reminders annai gave before leave-next.
- **Revisit when:** after the trip, with the design check's part 5: read the speeds annai logged in flight from the trace, then decide between one fact at the activity sensor ("faster than any car": no leave, no running late, no Driving at that speed) and accepting this entry. Part 5 covers only annai on screen: an activity sensor can't move the relay's copy. For a flight item with no end and a closed phone, that copy still comes as if the flight had landed at its start; when part 5 is decided, that half is a known-limitation question for the user (RULES, "Known limitations need the user's OK"), not a deferral, and the skill's line on a flight's start and end is what stands against it until then. Its plan meanwhile: the skill asks for a flight's arrival as well as its departure (the skill lines leave-next's row plans, after a real-model run), so a flight item has an end.

### A stay, flight or train item whose kind is a word annai's table doesn't have isn't recognised
- **Kind:** deferred.
- **What the traveller sees:** a plan item's kind is read through one table of words (`KINDS` in `src/core/live/plan-watches.js`): `flight` and `plane`; `rail` and `train`; `ferry`, `bus` and `coach`; `lodging`, `hotel` and `stay`; `meal`; and the booking's other kinds. An item linked to no booking whose kind is another word ("inn", "accommodation", "shinkansen") is an ordinary item: a check-in gets leave and running late within 1000 km; a train is no carrier, so a fixed item after it counts a drive from where the train left; a flight gets no 2-hour margin and a 300 m arrival circle. Linked to a booking, such an item takes the booking's kind (the entry below).
- **Why:** the plan item's kind is free text (`src/plugins/core-schemas/schemas.js`). Shiori's instructions (`src/core/agent/instructions.js`) and the plan-a-trip skill now name the words for a flight, a train, a ride and a stay, but no real model has been run on them (leave-next made no model calls).
- **Revisit when:** the next version, with the real-model run that checks the skill's line on a check-in item's time (the design check's part 4): any word she writes for a flight, a train, a ride or a stay that the table lacks joins it.

### An item with no kind, or a kind annai doesn't know, linked to a flight or train booking, takes the booking's rules
- **Kind:** deferred.
- **What the traveller sees:** in the reminders (`kindOf` in `src/core/live/plan-watches.js`) an item's own kind decides when annai's table knows the word (a `car`, a `hotel`, a `meal`, an `other`, an `event` or a `restaurant` on a flight's booking is no flight: no 2-hour margin, no 2 km airport circle, no carrier rules, where annai before leave-next read the booking's kind first and counted every item on it a flight); the Plan screen (`src/core/plan.js`) still reads the booking's kind first (the entry below). An item with no kind, or a word the table doesn't have ("checkout", "transfer"), linked to a booking of kind `flight` or `rail`, is of the booking's kind: a bag drop, an airport shuttle, a car pick-up or a check-out written that way takes the carrier rules (what comes after it doesn't count from its place, and waits for it to land when it is fixed), and on a flight's booking a flight's 2-hour margin and its late line of 1 hour before. So:
  - A "Bag drop closes" item at 13:05 on the booking of a 14:05 flight gets a "Leave soon" an hour before the flight's own would have come, and, on screen, a "Running late" while the traveller is in time for it. The flight itself is then read as a connection and gets neither.
  - A car pick-up at 17:00 on the booking of a flight that lands at 16:30 is the connection: no leave, no running late (with the kind `car`: "Leave soon: Car pick-up at 17:00, Car hire desk."). The flight is then named by its own title, with no terminal, as one of two legs; a car or hotel with no kind alone on a flight's booking is named as the flight, with its terminal ("Flight UA123 departs 17:00, Car hire desk T3").
  - A fixed car rental with an end (Nov 20 10:00 to Nov 23 10:00) on the booking holds back the leave and running late of every fixed item after it until that end; one before the end (a museum on Nov 21) gets neither.
  - An item on a flight's booking is no stop before, so the next item's leave reminder can come late with no position near (live mode off, or the phone's last position a flight away): the flight home after a check-out at 11:00 with no kind, 100 km from the airport, says "Leave soon" at 11:35 for its 14:05 departure, half an hour before its 2-hour mark, where the same check-out with the kind `lodging` gives 09:51, 1 h 44 min earlier; a dinner at 19:00, 100 km from the airport, after the car pick-up above gets it at 18:30, not 16:46.
  - The other leave reminders come early; the false "Running late" is on screen only, never pushed.
- **Why:** a flight Shiori wrote with no kind, or with a word of her own ("transport"), left to its booking keeps its 2-hour margin, which a flight read as an ordinary item would lose (it errs late: the fix round 2 fixer's Call 3). A bag-drop item written with no kind can't be told from a flight leg. Shiori's instructions now say to give flight, train, ride and stay items their kind, which leaves this to an item linked to a flight's booking that is none of those and has no kind.
- **Revisit when:** the next version, with the real-model run that checks the skill's line on a check-in item's time (the design check's part 4): if she links items with no kind to a flight's or train's booking, the instruction line also asks for their own kind (`car`, `meal`, `other`). Until then, give such an item its kind, or link it to no booking, or to a booking of its own kind.

### The Plan screen reads a booking's kind first, where the reminders read the item's own word
- **Kind:** deferred.
- **What the traveller sees:** the Plan's sets (`planRows`, src/core/plan.js:207) take the kind of an item from its booking first (`booking?.kind ?? item.kind`), where the reminders read the item's own known word first (`kindOf`, src/core/live/plan-watches.js). A car rental of kind `car`, 20 to 23 November, linked to the booking of a flight that has no times is a car for the reminders, and a flight's set on the Plan: its last row is "Arrive · Car rental", with no place; on a car's booking it is "Return · Car rental". Words only: the Plan's rows and Kokoro's view of today (src/core/koe/context.js:44); no reminder or time changes. It needs a multi-day item linked to a booking of another kind.
- **Why:** two readers answer "what kind is this item" from two sources, and `kindOf` with its table lives in the live code (leave-next). Moving it changes what every Plan set draws, which is its own change with its own tests.
- **Revisit when:** the next version, as its own change: `kindOf` and its table (`KINDS`) move to src/core/plan.js, which plan-watches.js already imports, and the Plan's sets read it too (Kokoro's view reads the same rows), with a test on the Plan for the car on a flight's booking. One answer, as the lessons say: remove one path rather than sync two.

### A closed annai can say "Leave soon" for an item at the destination, timed before the flight that gets the traveller there
- **Kind:** deferred.
- **What the traveller sees:** with live mode off, or the phone's last position a flight away (at home or at the departure gate), the push relay holds a "Leave soon" copy for a fixed item at the destination other than a stay (a car pick-up at the arrival airport, a meeting), half an hour before the item. If the plan times it before the last flight there lands, the notification comes while the traveller is at the hub or in the air: "Leave soon: Car pick-up at 16:00, Car hire desk." (no minutes). That holds when the flight is flexible, or fixed and starting after the item's time. The reminder waits only for the flight before it in the plan, not for the one that takes the traveller there. When that flight is fixed and starts before the item's time, it is the flight before it in the plan, and the wait runs past the item's time: a fixed flight 14:00 to 17:00 and the car at 16:00 give no copy at all.
- **Why:** a position a flight away counts as none, so the copy is counted from the plan's stop before or the half hour (leave-far's F1, so the closed annai still says it at the destination); the wait for a landing is the fixed flights and trains before the item in the plan, and the plan can't tell which flight takes the traveller to it.
- **Revisit when:** the next version, as its own change: look ahead to the next fixed flight or train after the item, and when the item is timed before it lands, and the traveller's place (or the stop before) is a flight away from the item, hold the copy until that carrier lands (about 8 lines in `planWatches`).

### The Driving strip keeps a flight already left as the next stop
- **Kind:** deferred.
- **What the traveller sees:** a flight or train stays "not over" until its end (else half an hour from its start), and its place is the place it leaves from. Driving while a flight is in the air (a position within a day's drive of the departure airport, such as the first hour of the flight, or a train on its way) lists it as the next stop: "SFO T3, 475 km, 512 min".
- **Why:** the strip counts an item over by its end, as Now does, and has no notion of an item the traveller has already left from. Older than leave-far.
- **Revisit when:** the next version, as its own change: the strip leaves out a flight or train once its start has passed.

### The Driving strip during a flight lists the destination's stops, with car times
- **Kind:** deferred.
- **What the traveller sees:** a phone at flight speed counts as moving fast, so Driving takes over, and the strip lists the stops ahead that are within a day's drive of the plane's position, with a drive's minutes. On a plane 804 km from a tour at the destination, 40 minutes before it lands: "Old Lighthouse, 804 km, 858 min". It is the arrival side of the entry above on a flight already left. Reminders are not affected: a fixed item after a fixed flight waits for it to land.
- **Why:** the strip (`routeStrip`, `src/core/now.js`) has no notion of a carrier that has not landed; the reminders have (`landed` in `planWatches`).
- **Revisit when:** the next version, as its own change: the strip leaves out a stop after a fixed flight or train that has not landed, by the way the reminders wait for it (its end, else its start), with a test.

### A reminder written while its trip's conversation is being opened never reaches Driving's card line
- **Kind:** deferred.
- **What the traveller sees:** a reminder of a trip written in the instant its conversation is being opened, while Driving shows that trip, is not drawn on Driving's "latest card" line: the line keeps the card before it until the next one arrives. The Reminder notice still shows it, and the conversation has it. Older than screens-next (Driving's listening before its read, built there, doesn't reach it); found by reading (a second opinion on screens-next's review), not run.
- **Why:** the loop holds a write for a conversation being opened (`#late`, in `#logIn`) and takes it in when the open ends (`#joinLate`, src/core/agent/loop.js). `#joinLate` returns before it tells the screens when the loaded transcript already has the entry (`e.seq <= this.transcript.through`), which is right for the conversation screen, drawn from that transcript, but Driving is told only through `'event'`.
- **Revisit when:** the next version: `#joinLate` tells an entry the transcript already holds to the listeners that didn't read it (Driving's), without a second draw on the conversation screen; the fix is in `#joinLate`, with a test that writes a reminder in that window.

### A partly added share's retry keeps the files kept before the failure twice
- **Kind:** deferred.
- **What the traveller sees:** a share of several files whose add fails partway (a write fails after the first file was kept, say) leaves its error on the share screen (on a card once the traveller has left it), and every file still in annai's inbox. Adding again, from the screen, from the failure card (an add that failed after the traveller left the screen), by Back to the share's address, or after a reload (these two by reading), adds every file again: the first is there twice ("one.pdf" and "one (2).pdf"). With "New conversation" (by reading), the retry makes a second conversation and puts the whole share in it, the first holding the part kept before. A calendar file's plan items are written by their UID, so the retry does not double those, but it writes them again, replacing a change made to one since the first add. Older than stage 8 (the add on main does the same); the failure card is one more way to reach it.
- **Why:** the inbox is emptied only when the whole add has succeeded (`add`, src/ui/screens/import.js), so a retry has nothing that says which files were kept. Fix round 1 of screens-next kept the progress on the screen (`kept`), so the retry on that screen added only the rest; it reached no other path, and it dropped the files kept before the failure from the calendar import and Shiori's wake (`keepFiles` and `bringIn` work over the paths of one call), so it was taken out again.
- **Revisit when:** the next version, with its design question: the inbox as the record of what is left (each file leaves the inbox once it is kept, so a retry from any screen, or after a reload, has only the rest), and the calendar import and the wake finished for what a failed add kept (so the retry's call sees the paths of the earlier one, or the failed add finishes them before it ends).
