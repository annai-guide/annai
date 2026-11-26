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
- **What the user sees:** a page still running release 7f0dc027 or older, before it restarts into the new annai, can't add or update the official plugins that say `api: 2`: OpenRouter, Custom provider, Gemini, OpenAI-compatible speech, the four backup kinds, the three search providers and Remote trace. Tapping Update says "was made for plugin API 2; this version of annai supports API 1", keeps the version it has, and offers it again at the next check. Other updates apply, nothing retries on its own, and a restart into the new annai fixes it.
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
- **What the user sees:** when no model here reads PDFs and the PDF pages plugin shows a PDF to a model that sees photos, only its first 10 pages go, at up to 1600 px on the longest side, each under a photo's request size (256 KiB by default, since pdf-pages-cap-next, 2026-11-25), so ten pages in one request are up to 2.5 MiB of pictures, 3.3 MiB as sent, in the PDF's turn and the next. The model is told how many were left out ("pages 1–10 of 23; the rest weren't sent"), so Shiori can say so. A model that reads PDFs itself still gets the whole file.
- **Why:** each page is a picture of about 1,600 tokens, and a booking's facts are on its first pages. More pages would cost more and take longer on the phone, for pages a booking rarely needs.
- **Revisit when:** a booking needs more than its first 10 pages.
- **Approved:** 2026-10-28, the user: "Accept" (the first-10 rule). The sentence on what ten pages send in one request: chief's decision C239 (2026-11-25, not the user's words, Q-AA option (1); undo: "about four pages a request" or "a total for the pages").

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
- **Since photo-budget-next (2026-11-21), also:** a turn's requests carry only the pictures of that turn and the one before; every older one is the "not sent again: read it" stub. So each picture leaves the request two turns after it came, and that turn's request misses the provider's prompt cache from the picture's place on, once per picture; with a provider that keeps turns (OpenAI Responses, Gemini) it starts the kept chain over once. Nothing is lost or wrong; the request stays text-sized on a slow link.
- **Since pdf-window-next (2026-11-22), a PDF too:** a PDF a model reads goes whole, whatever its size, in each request of its turn and the next; then it is a "not sent again: read it" stub naming its file (a web page's PDF: the tool to call again). So it leaves the request two turns after it came, and that turn's request misses the provider's prompt cache from its place on, once per PDF; with a provider that keeps turns (OpenAI Responses, Gemini) it starts the kept chain over once, where before the chain held it and it was not sent again. A later question about it costs her one more step: she reads it again, and it is sent again. Nothing is lost or wrong; from two turns on the request is text-sized on a slow link.
- **Why:** avoiding it needs annai to remember what each previous request sent, per model: more moving parts for a rare, one-turn cost. For the window: a text-sized request beats a cache hit on a spotty link ("we are an agent on the go possibly with spotty internet", the user, 2026-10-19).
- **Revisit when:** long trips with many photos get slow or expensive after a re-read, or the cache misses show as a cost the traveller notices; or the user says "keep photos in the request" or "keep PDFs in the request".
- **Approved:** 2026-10-28, the user: "Accept as known limitation"; widened for the window 2026-11-21, chief's decision C176 (not the user's words; to undo: "keep photos in the request"); widened to PDFs 2026-11-22, chief's decision C180 (not the user's words; to undo: "keep PDFs in the request").

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
- **Why:** the plain case worked, but every part built to make the spoken yes work in one more case drew a wrong grant in its next review, and the last review found one more on the live code: with one Shiori, "Yes." and, within its 3 seconds, a reminder annai says itself; the reminder closed the microphone, the "No, wait" said after it wasn't heard, and the trip was read 2.8 seconds after the listening had ended (the review of 2026-11-13, probe C1). That tripped the user's stop rule. A tap can't be mistaken.
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
- **What the user sees:** away from an offline pack, asking what is around brings OpenStreetMap's places after about 27 to 52 s (the median is 35 s; nearby waits up to 55 s for them; Wikipedia's articles come with them, each edition in its own request, three at once at most, then, with more than one edition, one Wikidata request naming the editions each article has, inside Wikipedia's own 25 s: 0.44 to 0.56 s in the editions design's checks). In about 1 call in 24 every server refuses (within 3 s with VK's server off; with it on, "busy" waits for VK's refusal too, which came at 43.8 to 50.5 s in 7 of its 14), and nearby says "OpenStreetMap is busy" and gives Wikipedia's articles only, or the offline pack's places where it reaches. nearby asks overpass-api.de first, and its z. and lz4. servers only after each refuses or fails. With Settings → Tools → "Also ask VK's server (maps.mail.ru)" on, VK's server is asked as well, beside them, and its answer is used when it comes first (it answered the old query in 14 to 22 s, in 10 of 24 calls; whether it runs the `if` the new query uses is not known: the one request of the new query it was asked, at the Sydney Opera House on 2026-11-16, came back a 504 from its front server in 1.3 s, with no word about the query, as 7 of its 24 requests did on 2026-11-14).
- **Why:** the wait is the public servers' queue before a query runs, not the query: in 24 hourly probes of the lighter query from one server (2026-11-15/16, nearby's default kinds at four landmarks, in the shape probed: a 300 m circle, then a 1000 m one), replayed under the code's own rule (overpass-api.de first, the next only after a refusal or a failure, one 55 s limit), 23 of 24 calls get places, in 27.5 to 51.8 s (the median is 35.3 s), as the old query's 24 did (27.5 to 51.3 s); nearly all of it passes before the first byte (Tokyo, the first run, the probed query: the first byte at 29.3 s of 29.4 s). The one of the 24 calls that had all three servers refuse was run 4 (Sydney), in 2.4 s. nearby now asks 250, 500 and 1000 m at the defaults, one circle more than probed; its three live calls with the circles as built (2026-11-16: the Sydney Opera House at the defaults, McWay Falls at 20 km, a point in Lake Michigan at 15 km) took 32, 49 and 44 s, overpass-api.de and z. refusing the first two at once (502, "at capacity") and lz4. answering them after 31 and 48 s. The query declares 64 MiB (`maxsize`, an eighth of the default 512). By Overpass's own rule a server starts a query only while what it declares fits in half of what is free (upstream's `src/template_db/dispatcher.cc`, `Global_Resource_Planner::probe`, read 2026-11-14), so a smaller declaration may start it sooner; the probes don't show that: overpass-api.de refused the query with the declaration 6 times in 24 (each a 502 "Timeout" in about half a second) and without it 10 times (nine such 502s and one 504 after 38.6 s), too few to tell apart (Fisher p 0.36). 64 MiB did not run out at wide radii in the live calls: a 15 km circle answering 400 places, and 20 km with all 8 circles run, gave no "out of memory" remark. overpass.private.coffee and overpass.kumi.systems never answered the old query, so annai doesn't ask them. A different query doesn't shorten the wait; a shorter one needs another server: VK's, behind its switch, or one of our own.
- **Revisit when:** the first drives' Trace shows calls past 55 s, or a faster public Overpass server appears.
- **Approved:** 2026-11-16, chief's decision (the user may reverse it): "Accept as a known limitation (Recommended)", the question's option 1. Why: the wait is the public servers' queue, the lighter query the user picked ("Plan the lighter query (Recommended)", 2026-11-14) is built, and the only shorter routes are a server to host or VK's behind the switch the user set off.

### Online, `nearby` can miss a nearer place where places thicken sharply outward
- **Kind:** known limitation.
- **What the user sees:** nearby asks for circles each half the radius of the next, smallest first, each wider one only while fewer than 40 places came (250, 500 and 1000 m at the defaults), so mostly the answer is one circle whole and its nearest 40 are the true nearest 40: at the Sydney Opera House the 500 m circle came whole, 75 places, and the Opera House (an outline) is first of the 40 listed (live call, 2026-11-16). But where one circle holds fewer than 40 places and the next, four times its area, 400 or more (more than ten times as many: the ring outside more than three times as dense as the circle inside), OpenStreetMap's answer is cut at 400 in its id order, every node before any outline, so a building or a park drawn as an outline is the first to be missing. A nearer place can then be missing while a farther one is listed. The answer then ends by saying that OpenStreetMap's answer stopped at 400 places, not chosen by distance, so a nearer place may be missing, and naming a radius to ask again with: half the circle that was cut, usually the circle before it, which held fewer than 40 places and so comes whole. That gives the nearest places within it, which can be few or none; the places between it and the first answer's rows stay unknown. Shiori can ask again, at the cost of another wait for OpenStreetMap (about 35 s, the entry above); when the smallest circle was the one cut, half of it is a new circle that can be cut again and says so again. Seen live (2026-11-16): at a point in Lake Michigan 8 km off Chicago's shore, 15 km and sights, the circles up to 7500 m held fewer than 40 (none of their places is in the cut answer) and the 15 km one 400 or more, so the answer was 400 nodes with no outline, and nearby's 40 rows ran from 7.6 to 9.9 km. A car coming to a city across open country, with the driving companion's 5 to 15 km look ahead, would meet the same (not seen on a drive). With the earlier step of 0.3 of the radius the cut came at the Sydney Opera House, where its 300 m circle held fewer than 40 and its 1000 m one 400 or more: all 10 saved answers of that query there are the same 400 nodes, none an outline, the Opera House not among them. A smallest circle (151 to 300 m for a radius over 300 m) that itself holds 400 or more would be cut the same; it was not seen: the densest saved one held 153 (Paris, 300 m).
- **Why:** Overpass can't sort by distance, so the nearest places are asked for as widening circles in one request, and its answer is capped at 400 (ten times the 40 kept), which bounds the download and cuts in id order. A smaller step between circles makes such cuts rarer and the query longer and slower to run (8 circles at 20 km, up to about 9.4 KB with every kind, at half the radius each; more at a finer step). nearby says when its answer was cut: when Overpass's answer holds 400 elements (counted as Overpass sent them, not as the rows nearby keeps), nearby's answer ends with that line, after the line saying the offline pack filled in for Wikipedia where it did. It names the circle to ask again with from the places that came: the first of the query's circles that holds 40 of them, by the distance each carries (an outline's is to its centre, so it can name a smaller circle than the one cut, still whole; or, rarely, a larger one, when an inner circle was cut, holding fewer than 40 nodes, and about 360 outlines touch it but are centred beyond it: the retry is then cut again, says so, and names a smaller circle), halved. Half the radius asked would not do: the query stops at the first circle holding 40 or more, so the circle cut is the widest only when no smaller one held 40; when an inner circle was cut, a query for half the radius is the query that already ran, and gives the same cut answer, another wait for nothing.
- **Revisit when:** a place known to be near is missing from a list in use, or the log shows cut answers on drives.
- **Approved:** 2026-11-16, chief's decision (the user may reverse it): "Accept, and nearby says when its answer was cut (Recommended)", the question's option 1; the follow-up ships in the next release and never holds stage 8. It narrows the user's "a lighter, nearest-first query" (2026-11-14) where places thicken sharply outward.

### In a city centre `nearby`'s Wikipedia articles reach a few hundred metres
- **Kind:** known limitation.
- **What the user sees:** `nearby` gives the nearest 50 Wikipedia articles (and the nearest 40 places, each list cut to its own count); around a dense city centre the 50 reach 156 to 520 m (Tokyo Station 325 m in the real check of 2026-11-20), and the answer says how far each list reaches and that farther ones within the radius aren't listed.
- **Why:** a kilometre around a city centre holds 200 to 560 articles (Tokyo Station 407, Times Square 559, the editions design's measurements of 2026-11-20), more than one tool result carries (40,000 characters); 50 is what one Wikidata request names, and it lists the whole kilometre at 20 of 34 measured stops (30 did at 17). The number follows the user's "Measure, then set (Rec.)" (2026-11-19) on the 30 articles.
- **Revisit when:** a traveller misses a known place nearby, or Wikipedia's relevance sort is tried.
- **Approved:** chief's decision C161 (2026-11-20, not the user's words), accepted as written.

### Inside the offline pack's circles `nearby` reads the pack even online, so a language added since the download is missing there
- **Kind:** known limitation.
- **What the user sees:** where the pack holds the whole circle asked, `nearby` answers from the pack, online too; an edition the pack doesn't hold yet (a language added since its download) is missing from those answers until the next download on Wi-Fi. The answer says a row may leave out an edition that has its article, and that Wikipedia may have more.
- **Why:** reading the pack first inside its circles is the design's (no request, no data on mobile data, the answer at once); the keeper brings the new edition about a minute after the change once on Wi-Fi. Asking only the lacking editions online would add about 20 lines and 10 KB a call; skipping the pack while something lacks, about 35 s and full data a call.
- **Revisit when:** a traveller who adds a language on the road misses its articles.
- **Approved:** chief's decision C163 (2026-11-20, not the user's words), accepted as written.

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
- **What the user sees:** annai is closed or killed (the phone locks and the system ends the page, or a reload) while Shiori is in a turn annai started by itself (GPS turned on, a reminder or watch firing, a plugin's wake). The next time that conversation opens, she takes the turn up and finishes it, possibly hours later: a reaction to GPS that is stale by then. A reminder she hadn't said yet is shown as a card when the conversation opens, and her restart is told so (since owed-leave-next, 2026-11-21; it was said late, by her, not shown as a card). Opening another conversation instead lets such a turn go at once, and shows its reminder as a card.
- **Why:** after a kill annai can't know what ran (a line cut in its playback, a call after it that never ran), so a reload takes every unfinished turn up. Letting annai's own turns go on a reload too would need the rule for what is owed to know from the log who started each turn and whether the user answered in it, the reminder's text stored with its wake, and an exception in opening: about 15 to 20 lines in the hardest logic, and a kill during the model call would still look like a wake kept for later.
- **Revisit when:** real use shows late answers after a reload that the user didn't want. (Its other condition, wakes keeping their reminder text in the log, was met by owed-leave-next on 2026-11-21 for the reminder part only, which it changed as above; the late take-up of her own turn stands as the user picked.)
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

### A short plan item that crosses midnight, and a booked flight, train or ride, stays on the Next line for up to half an hour after it ended
- **Kind:** known limitation.
- **What the user sees:** a plan item shorter than 30 minutes that starts on one day and ends on the next, in its own time zone (23:55 to 00:09, say), keeps showing on the conversation's "Next:" line after it is over: its start for up to 30 minutes after it began, then "Ends · <item>" until 30 minutes after its end. Then the line moves on or hides. Items within one day hide at their end. The same rows feed Drive's strip and the timeline card's Next (and fed Now until timeline stage 8).
- **Since carrier-rows-next (2026-11-18), a booked flight, train, ferry, bus or coach too,** on any day, because its booking is now its departure and an "Arrive" row with no place: a flight item with its end on its booking shows its departure until it lands, then "16:30 Arrive · …" until 17:00 (before, the line moved on to the next item at 16:30); a flight item with no end, or a booking with no item, shows its departure for 30 minutes, then its Arrive until 30 minutes after it lands (before, the departure stayed until it landed); a carrier under 30 minutes with no end keeps its departure for 30 minutes. Driving's strip is not affected (it drops a carrier once it leaves).
- **Why:** an item that ends on a later day than it starts is drawn as two rows, its start and its end, and a row with no end of its own lasts half an hour (the drive-test follow-ups design of 2026-11-02: "an end row is a row like any other"). A carrier booking's Arrive is such a row.
- **Revisit when:** a user is misled by it; the change is for the start row to carry the item's end.
- **Approved:** 2026-11-11, the user picked "Accept as a known limitation". Widened to flights, trains and rides on 2026-11-18: chief's decision C109, "accept the wider entry" (carrier-rows-next's proposed known limitation 4; not the user's words).

### With Koe on OpenAI Realtime, after a Stop, a line said to live Koe can be refused when its words arrive after her call
- **Kind:** known limitation.
- **What the user sees:** in live voice on OpenAI Realtime, they press Stop, then say something to Shiori. If the provider sends Koe's call to Kokoro before it sends the words of what they said, the call is refused as if they hadn't spoken: she says she can't check that now, and they have to ask again. When the words come first, it goes through. On the test stand-in, words 6 seconds late are refused. Real Gemini Live never sends them in that order: in 121 turns where Koe called `tell_kokoro`, the user's words came 0.5 to 14 s before the call every time (2026-11-12), so with Gemini this doesn't happen. OpenAI Realtime's order isn't measured (no key in use).
- **Why:** a Stop's hold ends when a line of the user's is written, and a live line is written when its words arrive. Changing that for a provider whose order is unmeasured, while Gemini never needs it, adds a rule nothing has shown is needed.
- **Revisit when:** a real OpenAI Realtime run or a drive shows the call before the words; then either the heard line is written before a tool call even with no words yet, or a turn that a tool call answers counts as the user's line.
- **Approved:** 2026-11-12, the user picked "Limitation, OpenAI only (Recommended)".

### Live Koe's tool calls in flight when another conversation opens are written into the conversation opened
- **Kind:** known limitation.
- **What the user sees:** in live voice, one of Koe's tool calls is still running (or its first write is waiting behind the other conversation's opening) when the user opens another conversation. The call is written in the conversation left, but its result lands in the conversation opened, as a result with no call, and the conversation left keeps a call with no result. When the call is Koe's `tell_kokoro`, the note itself lands in the conversation opened and wakes Kokoro there, which answers a question about the trip left, in the trip opened. Koe's spoken and heard lines are not affected: they are written where she spoke; nor are Kokoro's notes to Koe, which keep the conversation they were written in (since voice-off-next, 2026-11-25: one whose conversation is no longer open as it reaches Koe is shown there, silently, and Kokoro isn't woken), but for one shape, by reading: if the open has already read the conversation opened before Kokoro's note write gets the lock, the note is written and said there. (Reproduced on the test stand-in with a tool held while the switch ran; the version before this one did the same.)
- **Why:** a call's writes (`tool.call`, `tool.result`, and Koe's note through the channel) go into whichever conversation is open when they are written, and the switch changes it meanwhile; Koe's note wakes Kokoro in the open conversation. Binding the writes to the session's conversation, as her lines are, is a small change (pass it from the session's call through `liveCall` into `#runCall`), but it leaves what Koe's note for a conversation no longer open should do (not wake Kokoro there; kept for when the user comes back, as Kokoro's notes now are, or dropped), and a call that starts after the switch, which runs against the conversation opened. Those are decisions, not a pass-through, for a switch while one of Koe's calls runs.
- **Revisit when:** it happens to the user; the fix then: the session's conversation is bound to its calls' writes, after deciding what Koe's note to Kokoro for a conversation that is no longer open does, and what a call that starts after the switch does.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries. Kokoro's note in flight added on 2026-11-13, the user picked "Add to known limitation (Recommended)". Narrowed 2026-11-25 by voice-off-next: Kokoro's note in flight closed (the main session's call, a narrowing).
### A microphone failure during a tapped question ends the question, though it still stands
- **Kind:** known limitation.
- **What the user sees:** voice is off, her question shows its buttons, the user taps Shiori (the app's tap holds voice on for that exchange, so with voice off too a microphone opens; the loop's own `tap()` alone answers 'typing' with voice off, but the dock, a plugin's dock (`ui.shiori.tap()`) and, with voice on, the media keys call Halves', `halves.js` `tap()`), and the microphone stops (another app takes it: a phone call; dictation failing stops it only when the recording it falls back to fails too). A card says why (`micProblem`: "The microphone didn't start" when the track ends, "The microphone is busy" when another app holds it), but the question's buttons end and the model is told "annai couldn't listen: … The user may type.", and the question is over, though the user has not answered it; they can type their answer. (From reading the code and the review's probes. The version before this one closed the question too, and wrote an empty line of the user's and told the model "The user wrote: undefined".) Her question said aloud does the same in the by-hand phase after its 8 seconds.
- **Why:** `#earFailed` resolves a pending that is marked listening with the failure, whatever it was waiting for, and a question that waits by hand is also marked listening for as long as a tap's microphone is open. It is rare (another app taking the microphone while the user answers her question by a tap), the card says why, and the fix is one more condition in `#earFailed` (its Revisit below). Since tap-ear-next, `#closeEar` ends the listening its microphone served, after the lines it heard, but `#earFailed` clears the pending right after calling it, so that end never runs there: the failure is the pending's result.
- **Revisit when:** it happens to the user; the fix then: `#earFailed` leaves a question that waits by hand (`byHand`) waiting, as `#voiceChanged` does (the listening ends, the dock says it waits, `#noted` looks again), and gives the failure as the result to a wait's or speak's listening only, while a question keeps waiting for its buttons.
- **Approved:** 2026-11-13, the user picked "Approve all (Recommended)" for the backlog triage of the Deferred entries. Its words corrected to the code on 2026-11-18 (how the tap is reached, the card's two titles, when dictation's failure stops the microphone, the Revisit rule said plainly), meaning kept: chief's decision C114.

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

### Turns the version before this update left unfinished are read as finished
- **Kind:** known limitation.
- **What the user sees:** once per update, and only in a conversation where it happened, in a turn of hers the previous version left unfinished when the update installed: (a) a turn left paused by opening another conversation ("She picks it up when you come back") and not yet returned to is not picked up, and they ask again; (b) the same for a turn annai closed after her calls had come back or during her next model call (no "picks it up" line there); (c) a hand-over in such a turn reads as answered, so what she files when they ask again is outside its Undo; (d) a turn killed while her calls were still running is picked up, but what she files in it is outside the hand-over's Undo; (e) Try again on a "Shiori didn't answer" card, or a model-failure card, left from before the update carries no hand-over, so what she files is outside its Undo. (f) A file handed to her in a conversation logged before 2026-11-14, whose turn answered once and then failed (stopped, no model, cut), reads as read, so its trip's card doesn't count it as waiting (as before files-wait-next). Undo never takes back too much here: it leaves a file, which can be deleted by hand. A line of theirs she never replied to is still answered.
- **Why:** this version logs a record where her turn ends and reads her turn's end only from it. A log the previous version wrote has none, so each of its replies is read as the end of its turn. Reading those replies by the old rules too would keep the word-reading this change removes, in the same function.
- **Revisit when:** a user reports a "She picks it up when you come back" line that was never picked up after an update, or an Undo after the update that left a file.
- **Approved:** 2026-11-14, the user picked "Treat as finished (Recommended)" for old logs, and "Approve the wider entry (Recommended)" for this entry with all five effects. Widened by (f): chief's decision C252, 2026-11-25 (not the user's words; to undo: "leave the old-log file case an open finding").

### In a conversation saved before the take-up record, the Undo line of a turn that took a hand-over up partway can sit higher
- **Kind:** known limitation.
- **What the user sees:** opening a conversation saved before the update with the take-up record (2026-11-17), where a file was handed over while Shiori was working, the Undo line of that hand-over can sit under an earlier line of hers or under an earlier turn's card ("Her turn ended"), above the user's later words and her last line, where the version before put it under her last line. It shows, Undo takes back exactly what she filed under the hand-over, and nothing moves while the user looks.
- **Why:** such a log has no record of when the turn took the hand-over up, so the line is looked at only at the turn's `turn.end` and stays where it was; keeping the old placement for these logs would bring back the screen state the take-up record removed (spec §16.2), kept for good for conversations of a few days.
- **Revisit when:** the user sees it and it bothers them.
- **Approved:** 2026-11-17, chief's decision C96 (the user's question "Accept it as a known limitation (Recommended)", decided by chief; not the user's words).

### The realtime check's Japanese promise words miss some promises and flag some ordinary sentences
- **Kind:** deferred.
- **What the user sees:** nothing in annai. A tester running the realtime check's Japanese filler trap (`relay-filler-ja`) can see "no filler" pass a promise the list doesn't name (「今後は改めます。」, 「以後は改めます。」, 「もうしません。」, 「二度と言いません。」), or fail an ordinary sentence that names 以後 or 今後 with a promise-like verb in the same clause (「今後はこのルートを案内します。」). 「ご承知おきください。」 fails too (承知 has no guard for ご, as 理解 has).
- **Why:** the check reads Koe's words through a word list (`FILLER_CJK`, scripts/realtime/analyse.mjs); every round of langs-next (2026-11-17) moved its edge (the bare words, then a clause scan), and each move traded one wrong shape for another. Found by the second opinions on rounds 1 and 2; a dev tool only, so it waits for its own change rather than a third patch.
- **Revisit when:** the next change to the realtime check: decide whether the trap reads promises by a word list at all (bare 以後/今後 flag every use, which costs a tester one read of the record; a false pass hides the rule), with a pinned sentence for each form kept.

### Kokoro can write its notes to Koe in English in a Japanese conversation
- **Kind:** deferred.
- **What the user sees:** with Koe and Kokoro on Claude Sonnet 5.5, Koe's Japanese can come out stiff when Kokoro's note to it was English ("Tell the user in Japanese: …"), seen once in a live run on 2026-11-14. Since 2026-11-17 Kokoro's instructions say to write its notes in the language it answers in; with Kokoro on Gemini its notes were Japanese both before that line and after it (7 of 7, then 6 of 6, `real-relay-fact-ja`), so whether the line moves Sonnet, the model that showed the shape, is not yet known.
- **Why:** the run on Sonnet couldn't be made: the Anthropic key had no credit on 2026-11-17 (a credit 400 on the first request).
- **Revisit when:** the Anthropic key has credit: `real-relay-fact-ja` with `--real-model sonnet --anthropic-key <file> --ui ja --times 5` (docs/testing/realtime-check.md, "Koe's own words in Japanese"). Five runs, because on 2026-11-14 English notes came in 1 of 2 runs, so two runs with the line doing nothing show no English note about 1 time in 4 (five, about 3%). Every note's words for Koe in Japanese, with no English text to translate, closes this entry; an English note needs other words.

### Two listed languages in one script that annai has nothing to tell apart count for neither in the summary's language (the L1 question)
- **Kind:** known limitation.
- **What the user sees:** a traveller who lists two languages written in the same script, where annai can tell the lines of the two apart only for one of them or for neither, gets those lines counted for neither in the summary's and the recap's language. The summary then comes in the first listed language, or in the other one once a line shows it. A language counts, as before, when it is the only one listed in its script or the phone's. Which pairs:
  - **Latin letters:** one of Polish, Czech, Slovak, Hungarian, Romanian, Croatian, Slovenian, Turkish, Indonesian, Malay, Filipino, Swedish, Norwegian, Danish, Finnish, Catalan or Swahili (the 17 with no small-word list) beside another language in Latin letters, English included; Vietnamese is told only by its own marks. [en, tr] with Turkish lines (「Bu akşam nerede yemek yiyebiliriz?」, 「Yarın müzeye gidebilir miyiz?」, 「Bu gece nerede kalacağız?」) gives English, the first listed; [tr, en] with those three and one English line (「Where should we eat tonight?」) gives English; [pl, en] with Polish lines gives Polish only as the first listed, and terse English beside it ("Hotel near station") counts for nothing. With [tr] alone, a Turkish phone, or [tr, ja], Turkish.
  - **Cyrillic and Arabic:** Bulgarian or Serbian beside Russian, Arabic beside Persian: the summary counts nothing for the lines ([en, ru, bg] with Russian lines gives English), while the phone's voice reads such a sentence in the first listed language written in the script (Russian), and a Ukrainian phone's Cyrillic is Ukrainian.
  - **A language with a list beside one that has none, or two with lists:** the small words the 7 languages with a list share count for the other (a Dutch line with "is" and "open" has two of English's: [en, nl] with Dutch lines can give English). Where every listed Latin-script language has a list (English, Spanish, French, German, Italian, Portuguese, Dutch), one small word of one and none of the other's names the line; with a listed language that has none, two are needed.
- **Why:** annai has small words for 7 languages and nothing else to read a Latin line by (no letter statistics, no library: annai has no third-party code in `src/`). The ways to close it are three: 17 more word lists that must share no word with each other and with English; an elimination rule (a Latin line with no small word of the listed language that has a list is the other one; about 10 lines, which the check measured to fix 10 of 18 cells and break Danish, whose "for" and "to" are English's); or a library that reads the letters (franc: 252 KB, 7.5% of what annai ships, a `docs/deps.md` entry and a budget rise). What fixes it for the traveller today: "Shiori answers in" set to that language.
- **Revisit when:** a traveller who lists such a pair reports it; what fixes it for a traveller today: Settings → Languages, "Shiori answers in" set to that language.
- **Approved:** chief's decision, 2026-11-17 (C100; not the user's words), on the proposal "Accept it as a known limitation (Recommended)".

### Her reply to the "you haven't answered" cue can still be private text
- **Kind:** deferred.
- **What the user sees:** after answering her question card, if her reply showed nothing and the cue followed, in about 1 of 9 forced runs she answered again in plain text the user never sees, and "Shiori didn't answer" showed.
- **Why:** the cue says only speak, show and ask reach the user; a model can still write plain text.
- **Revisit when:** the next version: firmer cue words, measured on the ask-owed run's forced set.

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

### A leave reminder shows before annai records the arrival when annai's first fix back on screen is slow or imprecise
- **Kind:** deferred.
- **What the user sees:** the phone locks on the way to a fixed item, and the traveller arrives while annai is off screen. When annai comes back on screen with live mode on and GPS on and allowed, its catch-up waits up to 15 s for the first fix (`FIX_WAIT_MS`, src/core/live/live.js; with live mode or GPS off it ends at once). With a fix at the place (within the item's arrival radius, 300 m or a flight's 2 km, and itself that accurate) inside that time, the catch-up says only "Nepenthe: Lunch at Nepenthe." and leaves out the item's leave line (leave-next). With a slower fix (a poor signal, a cold GPS) the catch-up ends at 15 s; with a first fix less accurate than that, or off the place, it ends with that fix. Either way it says "Leave soon: Lunch at Nepenthe at 12:00." to a traveller who is already there, and the arrival comes in a wake of its own a couple of minutes later, once annai has seen them stay: both lines, as before leave-next.
- **Why:** the arrival can't be known before a fix, and the catch-up ends with the first fix or after 15 s, whichever comes first. Holding a timer-ended catch-up's leave line for a later fix would lose it when no fix ever comes. How often a real phone's first fix beats 15 s is not measured.
- **Revisit when:** after the trip, with the trace's first-fix times and accuracies after annai is back on screen: if many come after 15 s, hold a timer-ended catch-up's leave line for the fix, or leave it out of the arrival's wake.

### A delayed flight, or one with no arrival time, lets the next item's reminders fire in the air
- **Kind:** deferred.
- **What the traveller sees:** what comes after a flight (or a train or ride) waits for its end on the plan, else its start (leave-far, 2026-11-16). A plane that lands late, or a flight item with no end, lets the next fixed item's "Leave soon" and "Running late" come while the traveller is still in the air (with a position within 1000 km of the item, "Running late: … About N min away" with a big N). The push relay's copy waits only for the flight's end, else its start: a flight at 14:00 with no end and a car pick-up at 16:20 give a copy due 15:50 with no position (14:00 when annai last saw the traveller at a departure airport within a day's drive), while the plane may still be in the air. A second flight after a flight item with no end is not read as its connection, which would get neither: the first is taken to land when it departs, so the second gets its own "Leave soon" and "Running late" from the first's start, as before leave-next, at the first's departure airport (at the gate, or delayed on the ground) or in the air: "Running late: Flight AB 2 departs 11:30, Schiphol. About 403 min away." for a first flight at 08:00 from Heathrow.
- **Why:** annai doesn't know where the plane is; the plan's time is all it has. The plan-a-trip skill expects a flight's end ("A flight starts in the departure airport's zone and ends in the arrival's") but doesn't ask for one, and its bookings line names only "a flight's departure" (skills/plan-a-trip/SKILL.md:27); how often a flight item has no end is not measured. Counting the wait from the first stop annai sees after the flight is not built (the design check, 2026-11-17): it would hold back true reminders whenever annai sees no stop after the landing, and the relay can't see a stop while annai is closed. Taking the linked booking's end for a flight item with none was built in leave-next and taken out in its fix round: a booking's end is often a return's, a tour's or a stay's, not this flight's arrival, and it took away reminders annai gave before leave-next.
- **Revisit when:** after the trip, with the design check's part 5: read the speeds annai logged in flight from the trace, then decide between one fact at the activity sensor ("faster than any car": no leave, no running late, no Driving at that speed) and accepting this entry. Part 5 covers only annai on screen: an activity sensor can't move the relay's copy. For a flight item with no end and a closed phone, that copy still comes as if the flight had landed at its start; when part 5 is decided, that half is a known-limitation question for the user (RULES, "Known limitations need the user's OK"), not a deferral, and the skill's line on a flight's start and end is what stands against it until then. Its plan meanwhile: the skill asks for a flight's arrival as well as its departure (the skill lines leave-next's row plans, after a real-model run), so a flight item has an end.

### A stay, flight or train item whose kind is a word annai's table doesn't have isn't recognised
- **Kind:** deferred.
- **What the traveller sees:** a plan item's kind is read through one table of words (`KINDS` in `src/core/plan.js`, which the reminders, the Plan and Kokoro's view of today all read): `flight` and `plane`; `rail` and `train`; `ferry`, `bus` and `coach`; `lodging`, `hotel` and `stay`; `meal`; and the booking's other kinds. An item linked to no booking whose kind is another word ("inn", "accommodation", "shinkansen") is an ordinary item: a check-in gets leave and running late within 1000 km; a train is no carrier, so a fixed item after it counts a drive from where the train left; a flight gets no 2-hour margin and a 300 m arrival circle. On the Plan, such a stay over several days ends with "Ends", not "Check out", and such a train's end row stands where it left. Linked to a booking, such an item takes the booking's kind (the entry below).
- **Why:** the plan item's kind is free text (`src/plugins/core-schemas/schemas.js`). Shiori's instructions (`src/core/agent/instructions.js`) and the plan-a-trip skill now name the words for a flight, a train, a ride and a stay, but no real model has been run on them (leave-next made no model calls).
- **Revisit when:** the next version, with the real-model run that checks the skill's line on a check-in item's time (the design check's part 4): any word she writes for a flight, a train, a ride or a stay that the table lacks joins it.

### An item with no kind, or a kind annai doesn't know, linked to a flight, train or ride booking, takes the booking's rules
- **Kind:** deferred.
- **What the traveller sees:** in the reminders and on the Plan (`kindOf` in `src/core/plan.js`) an item's own kind decides when annai's table knows the word (a `car`, a `hotel`, a `meal`, an `other`, an `event` or a `restaurant` on a flight's booking is no flight: no 2-hour margin, no 2 km airport circle, no carrier rules, where annai before leave-next read the booking's kind first and counted every item on it a flight; on the Plan, a car rental of kind `car` over several days on a flight's, a train's or a stay's booking is a car's set, "Pick up", the days and "Return" at its place, with the booking's own rows beside it, whether the booking has times or not, since kind-next: a plan item that is a flight, a train, a car or a stay on a booking of another of them draws its own rows (its set when it spans days, one row when it has no end), keeps its own end and stands for none of the booking's rows; its rows open the item and carry none of the booking's checks). An item with no kind, or a word the table doesn't have ("checkout", "transfer"), linked to a booking of kind `flight` or `rail`, or of a ride's kind (`ferry`, `bus`, `coach`: booking kinds of their own since booking-next, read as a train's), is of the booking's kind: a bag drop, an airport shuttle, a car pick-up or a check-out written that way takes the carrier rules (what comes after it doesn't count from its place, and waits for it to land when it is fixed), and on a flight's booking a flight's 2-hour margin and its late line of 1 hour before. So:
  - A "Bag drop closes" item at 13:05 on the booking of a 14:05 flight gets a "Leave soon" an hour before the flight's own would have come, and, on screen, a "Running late" while the traveller is in time for it. The flight itself is then read as a connection and gets neither.
  - A car pick-up at 17:00 on the booking of a flight that lands at 16:30 is the connection: no leave, no running late (with the kind `car`: "Leave soon: Car pick-up at 17:00, Car hire desk."). The flight is then named by its own title, with no terminal, as one of two legs; a car or hotel with no kind alone on a flight's booking is named as the flight, with its terminal ("Flight UA123 departs 17:00, Car hire desk T3").
  - A fixed car rental (no kind) with an end (Nov 20 10:00 to Nov 23 10:00) on the booking holds back the leave and running late of every fixed item after it until that end; one before the end (a museum on Nov 21) gets neither. On the Plan, when the flight's booking has no good start and end (no times, or one of them), it is a flight's set: its last row is "Arrive · Car rental", with no place, and Kokoro's view of that day says the same; when the booking has a start and an end (the flight at 14:05, landing 16:30), it is one row with no end, "Car rental" at 10:00, which stands for the flight's departure on its day: no return, no days, and the flight's departure row is not drawn; its Arrive at 16:30, with no place, is (since carrier-rows-next a flight is its departure and its Arrive whatever the day).
  - An item on a flight's booking is no stop before, so the next item's leave reminder can come late with no position near (live mode off, or the phone's last position a flight away): the flight home after a check-out at 11:00 with no kind, 100 km from the airport, says "Leave soon" at 11:35 for its 14:05 departure, half an hour before its 2-hour mark, where the same check-out with the kind `lodging` gives 09:51, 1 h 44 min earlier; a dinner at 19:00, 100 km from the airport, after the car pick-up above gets it at 18:30, not 16:46.
  - The other leave reminders come early; the false "Running late" is on screen only, never pushed.
  - An item whose own word is one of the booking's generic kinds (`other`, `meal`, `event`, `restaurant`) is that word on a flight's or a stay's booking too, in the reminders since leave-next (pinned for a flight's booking in `test/unit/live-plan-watches.test.js`, and for a `meal` on a stay's; not for `other`, `event` or `restaurant` there) and on the Plan since kind-next. A red-eye written `other` on a flight's booking that has no good start and end (no times, or one of them): its arrival row on the Plan reads "Ends · AN 9 red-eye" with the departure airport under it (a flight's reads "Arrive", with none), and Kokoro's view and Driving's strip read the same rows; when the booking has a start and an end, the booking draws its own "Arrive · AN 9" at the landing time, with no place, after the item's row at its start. Its leave reminder is at its start, with no 2-hour margin, either way. A stay written `other`, on a booking with no good start and end: "Ends" in place of "Check out", no check-in or check-out names, "day 2 of 3" where a stay says "night 2 of 2"; on a stay's booking with a start and an end, the booking draws its own "Check out" and "night 2 of 2" beside the item's row, which has no "Check in" name. The word also still stands for the booking on its day: an "Airport shuttle" of kind `other` at 05:00 on the flight's booking (a flight at 07:00, no flight item) hides the flight's departure row (its Arrive stays, when the booking has a landing time).
  - The same thing written as two of the four kinds draws two sets, since the rule reads them as two things: a sleeper train, an item of kind `lodging` on its `rail` booking with the same times, shows four rows ("Check in · Nightjet sleeper" and "Nightjet" at 22:00, "Check out · Nightjet sleeper" and "Arrive · Nightjet" at 08:00); a campervan written `lodging` on its `car` booking shows both sets, eight rows; a train leg written `rail` on a flight's booking with the same times, overnight, shows two departures at that time and two Arrives at its end (the same day, the train is one row with both times beside the flight's departure and Arrive).
  - A shuttle of kind `bus`, `ferry` or `coach` linked to a flight's booking hides the flight's departure row on that day, as one of kind `other` does, and keeps its own end, as on main; the flight's Arrive is drawn after it: an "Airport shuttle" of kind `bus` at 06:00 to 07:30 on the flight's day (the flight 09:00 to 12:00) leaves the day with "Airport shuttle" 06:00 to 07:30 and the flight's Arrive at 12:00 (main: the shuttle alone). The flight's departure is nowhere, as on main.
  - A no-kind item on the arrival day of a flight's booking hides the flight's "Arrive": a "Taxi to hotel" at 09:00 on the 21st, linked to a flight from 22:00 on the 20th to 08:00, leaves the taxi and the departure, with no arrival. On a flight that lands the day it leaves, a second item on its booking that day (the departure's day too, in the departure's zone, when the flight crosses zones: an item the evening before is no arrival's) does the same: a flight item at 14:05 and a "Taxi to hotel" at 17:00, both on the booking of a flight landing at 16:30, leave the two items and no Arrive row; the flight item shows its own end when it has one ("Fly" 14:05 to 16:30, as on main), and with none the arrival is nowhere (as on main).
  - A no-kind item with an end the same day on a flight's booking keeps its row, as on main: a "Bag drop" at 13:05 to 13:20 on the booking of a flight 14:05 to 16:30 is "Bag drop" 13:05 to 13:20, standing for the flight's departure, then the flight's Arrive at 16:30 (since carrier-rows-next; main: no arrival); on a flight's booking with no times it is the same row, "Bag drop" 13:05 to 13:20, with a leg from its place when it has one (the entry below). Driving's strip drops such an item's place at its start, as a flight's: a car pick-up with no kind at 17:00 on a flight's booking leaves the strip at 17:00, where main kept it until 17:30.
  - A one-way car linked to a flight's, a train's or a stay's booking returns at its pick-up place: a plan item has one place, and a car on another thing's booking reads nothing of it, its drop-off included (such a booking can carry one: `src/core/bookings.js` writes an end place given as `return`, `dropoff` or `checkout`, in any spelling, to `fields.dropoff`), so "Return · Car rental" is at the pick-up place on the Plan and on Driving's strip.
  - Readers other than the Plan's rows and the reminders' marks still take the linked booking's name and marks for an item that is another thing than it: a flight item linked to a stay's booking (a package) gets the reminder "Leave soon: Flight Hilton Waikiki 5 nights departs 10:00, ANC." (`whatOf` in `src/core/live/plan-watches.js` is given the booking; on a car's booking with a terminal, "Flight Car hire departs 10:00, ANC T3"), and a car pick-up timed at a flight's unsure landing is "not sure the time was read right" in the plan rows Shiori is given (`src/core/agent/context.js`) and in the recap's plan table (`src/core/after/journey.js`), where the Plan and the reminders now say it is sure. The name is older than kind-next (its round-2 re-review, V1); the split in the marks comes with kind-next's fix round 2, which gave the Plan's rows and the reminders' marks `anotherThing`'s answer (the second opinion's finding 1); the fix is one answer for these readers too (`whatOf(title, marked, …)`, prototyped: "Leave soon: Flight to Honolulu at 10:00, ANC."; a `bookingMarks` helper beside `anotherThing`), held with this entry by the step back.
  - A ride booking stored as `other` before booking-next, with no ride item linked to it, still ends at its place: an "other" booking "Ferry ticket", Port A 19:00 to 07:00 the next day, and no `ferry`, `bus` or `coach` item, ends "Ends · Ferry ticket" at Port A, with a leg from there (with a linked ride item it ends "Arrive", no place, since kind-next; a booking of kind `ferry`, `bus` or `coach` does with none since booking-next). Its details say Starts and Ends, Shiori is told "the start time" and "the end time", and a time she writes under an alias with no zone (`arrive: "2026-11-21T07:00"`) takes the trip's only zone, which a ride booking's never does. Nothing rewrites a stored record: changing its kind to `ferry`, `bus` or `coach` (her patch, or the user's own edit) fixes all of it.
  - A shuttle (a `bus`, `ferry` or `coach` item, or one with no kind) linked to a stay's or a car's booking on the check-in or check-out day (a car's pick-up or return day) hides that day's row: an airport shuttle at 08:00 on the 20th linked to a stay from the 20th to the 22nd leaves no "Check in · Harbor Inn" on the Plan, one on the 22nd no "Check out"; on a day between, both stay; as the flight's shuttle above does.
  - A plan item that spans days, linked to a booking whose own span is within one day and that stays one row, shows its end nowhere, as before carrier-rows-next: a "Festival" item from Nov 20 09:00 to Nov 22 11:00 on an event booking timed 09:00 to 17:00 on the 20th shows only "09:00 Festival", and so does a three-day car item on a `car` booking read as one day ("09:00 Car"). The item gives up its end when it spans days and its booking has a good span, but a booking that stays one row draws no end row for it. The fix belongs in the item's `view` line (`src/core/plan.js`, in `planRows`): the item gives up its end only when its booking draws an end row (the booking splits, or is a stay). It is this entry's part (which item gives up its end), so it waits with the real-model run below.
- **Why:** a flight Shiori wrote with no kind, or with a word of her own ("transport"), left to its booking keeps its 2-hour margin, which a flight read as an ordinary item would lose (it errs late: the fix round 2 fixer's Call 3). A bag-drop item written with no kind can't be told from a flight leg. Shiori's instructions now say to give flight, train, ride and stay items their kind, which leaves this to an item linked to a flight's booking that is none of those and has no kind.
- **Revisit when:** the next version, with the real-model run that checks the skill's line on a check-in item's time (the design check's part 4): if she links items with no kind to a flight's, a train's or a ride's booking, the instruction line also asks for their own kind (`car`, `meal`, `other`). The same run shows whether she writes `other`, `meal`, `event` or `restaurant` for a flight or a stay itself: if she does, such a word on a flight's or a stay's booking is taken as the booking's (the reminders' pinned test is edited with it); if she writes them for other things (a shuttle, a dinner), the rule that makes an item another thing than its booking (`THINGS` in `src/core/plan.js`: a flight, a train, a car or a stay) widens by the words she writes for them (`bus`, `ferry`, `coach`, `meal`), and never to a generic booking kind (`other`, `restaurant`, `event`): a meal on its restaurant's booking stays one row with it, and a ferry on an `other` one stays one row with its own end, and its booking, when it has a good start and end (each in a zone annai knows, the end after the start), draws its Arrive beside it (a ferry item and its `other` booking both 12:00 to 13:30 draw "12:00–13:30 Ferry", then "13:30 Arrive · …"; with no times on the booking, or a start only, the ferry is "12:00–13:30 Ferry" alone and nothing draws an Arrive; `test/unit/plan.test.js:643`, "an item of a generic word on its booking is still the booking's own thing", pins the two rows, beside the reminders' test that pins the same words on a flight's booking (`test/unit/live-plan-watches.test.js:819-827`); widened to every known kind, both draw twice). A shuttle she writes `other` needs its own kind from her. The new bullets (two sets for one thing, a shuttle or a taxi hiding a flight's or a stay's row, a one-way car's return place, another thing's name and marks in the other readers) wait on the same run; the ride booking stored as `other` waits on the first one the user has, which takes a change of its kind. Until then, give such an item its kind, or link it to no booking, or to a booking of its own kind.

### A flight, train or ride the Plan can't split still draws a leg from where it leaves
- **Kind:** deferred.
- **What the traveller sees:** a booked flight, train, ferry, bus or coach with a good start and end (each in a zone annai knows, the end after the start) is its departure and an "Arrive" with no place, whatever the day (except one that lands on an earlier local day, over the date line, which stays one row, as before carrier-rows-next), and so is a plan item of one that spans days (`planRows` in `src/core/plan.js`, since carrier-rows-next), so the Plan draws no leg from where it left. A plan item that ends the same day is one row with its end, at its departure place, as before carrier-rows-next: splitting it was built, and the findings of two review rounds all sat in it (which item gives up its end, which stands for an Arrive, which draws a booking's set), so only a booking's own rows are split. In these shapes (all as before carrier-rows-next) the row keeps its place and the Plan draws "≈ 370 km apart · Directions" from it to the next stop within 1000 km:
  - A same-day carrier item with no booking that has times: a "Shinkansen" 09:00 to 10:30 with no booking, or on a booking with no times or a start only, then a temple 370 km on, is one row with both times and has its leg from the station. The same for a carrier item with no end, and for a booking with a start only and no item.
  - A flight, train or ride item on a booking of another kind (a stay's, a car's, an event's, a package's): a bus on a stay's booking, a ferry on a car's, a flight on a package booked `other` or `event` (`test/unit/plan.test.js`, "guard, not the change"). The row keeps its end and its place; the leg runs from it.
  - Several items on one carrier booking, where an item stands for the Arrive or nothing draws one: a check-in at 06:30 beside the departure item, a flight item and a taxi, a connection's two legs, a day return's out and back items, a second leg on the next day of a booking with no times whose first leg is an overnight set. Each item keeps its end (its row before carrier-rows-next) and its place, and the leg to the next stop runs from the last one's place.
  - A ride stored as `other` before booking-next, with no ride item linked to it (nothing says it is a ride): the Plan ends it "Ends · Ferry ticket" at the port with a leg from there (the entry above), and Driving's strip lists the port while the traveller is aboard. With a ride item linked, the strip drops the port once the ride leaves, also for a booking with no end (that one stays the start-only shape above for the Plan).
- **Why:** a leg is drawn between two rows next to each other with places, and a row with a place and no Arrive after it can't be told from a stop. The one-line skip (`if (carries(a)) return null` at the top of `legKm`, `src/core/plan.js`) would remove all of these legs but the last (nothing says that row is a ride, so `carries` is false for it), but it also removes a true leg after a car pick-up with no kind on a flight's booking, and after a carrier item written at the place it arrives at: Shiori's writing decides which of the two is more common, and no real model has run on it (how often she writes a flight item with no end, a flight item with no booking that has times, or several items on one booking, is not measured; the plan-a-trip skill expects a flight's end, `skills/plan-a-trip/SKILL.md:21`, but names only "a flight's departure" for the item a booking implies, `:27`). A carrier with no end has no Arrive to draw without inventing a time. A rule for which item stands for an Arrive, so that each carrier's Arrive is drawn, and a split of a same-day plan item were proposed or built in this change's reviews and not kept: both are in the part the entry above holds with its step back.
- **Revisit when:** kind-next's real-model run (the one the entry above waits on) shows what Shiori writes for a flight's end and for the items beside it: then either the `legKm` skip (a leg never starts at a carrier's row), or no item standing for a same-day carrier booking's Arrive (the re-review of the second fix round's S1: `standsFor`'s day check goes and `standsFor` is its text before carrier-rows-next again, one call site changes), or the skill line that asks for a flight's arrival with its departure, or a mix of them. S1, prototyped in that re-review, lost no time the code before carrier-rows-next showed (none in 100,000 random shapes). Because every same-day carrier booking then draws its Arrive, it closes the leg that would run across it, from the row before the Arrive to the row after it, in the check-in, connection, day-return and departure-plus-taxi shapes above (in the first three the leg from the last item to the next stop, in the taxi shape the flight item's leg to the taxi); a leg between two rows that are both before the Arrive stays (a connection's first leg to its hub, a day return's outward leg to the first stop at the far end), and only the `legKm` skip removes it. S1 costs the shape where a departure item and an item written at the arrival moment ("Arrive Hub" at 10:00, at the hub) are both on a same-day carrier booking, 08:00 to 10:00 and titled "Ticket": the arrival item then shows beside the booking's "Arrive · …" instead of standing for it, and when its title sorts before the booking's title, the Arrive with no place lands between it and the next stop, so the true leg from that item's place to the next stop, which the code before carrier-rows-next drew and today's code keeps, is gone. Today's code has the same cost when the arrival-moment item is the only one linked to the booking: it stands for the departure row (a booking's start row is stood for by day alone, `standsFor` with no `also`, `src/core/plan.js`), the booking's Arrive is drawn after it, and the leg from its place is gone, with or without S1. Neither S1 nor today's day check is clearly better until the run shows whether she writes items before or after a flight on its day, or one at the arrival time. A traveller who reports such a leg brings it forward.

### Driving's strip drops a delayed flight's airport at its planned departure
- **Kind:** known limitation.
- **What the traveller sees:** a flight planned for 14:05 and delayed to 16:00: the traveller, still driving to the airport at 14:10, sees the airport gone from Driving's strip of next stops. The same for a delayed train, ferry, bus or coach and its station or port. Before carrier-rows-next (2026-11-18) the strip kept a flight until its planned end, or 30 minutes from its start when it had none, by accident.
- **Why:** the strip drops a carrier once it leaves (`routeStrip`, `src/core/now.js`), the fix for the port listed as a stop while the traveller is aboard; keeping it longer brings that back, and annai doesn't know of a delay. It needs a delay longer than the traveller's own lateness.
- **Revisit when:** annai comes to know a flight's delay (a flight-status source), or a traveller reports it.
- **Approved:** 2026-11-18, chief's decision C110, accepted as worded (carrier-rows-next's proposed known limitation 5; not the user's words).

### A booking detail named like a part the details draw, holding something else, is not drawn
- **Kind:** known limitation.
- **What the traveller sees:** when a booking's own part drew its line (its place, start, end, confirmation or cost) and its details hold a field of the same name with something else, only the part's line shows (checked when Shiori marked the part unsure): confirmation "ABC123" beside a detail "XYZ789 (e-ticket)" shows only "Confirmation: ABC123"; a ferry's "Departs 7:00 PM" beside a detail giving 10:00 shows only 7:00 PM, with no sign of the other time (checked only when Shiori marked the time unsure). The booking keeps the field and Shiori reads it.
- **Why:** one doubt, one line and one check (`bookingFacts`, `src/ui/format.js`). booking-next's first round drew such a field when it differed, comparing words, objects and times (it drew raw keys, read a time in the phone's zone and hid an extra key); its second compared text only (it drew a conflicting time with no check, and a second Departs line); the rule before booking-next has none of these. No real model has been seen writing such a field: the trace's booking writes of 2026-10-18 to 11-17 hold `fields.confirmation` only on bookings with no confirmation of their own, where the field is the part's line. The traveller's bookings backup of 2026-11-16, read once on this machine with their OK (2026-11-18, "Yes, one read (Recommended)"), holds none either: a confirmation code in a booking's details only where the booking has no code of its own.
- **Revisit when:** a real booking has one. Then: check the part's line whenever such a field is there (no comparison), or draw such fields again, with a design first.
- **Approved:** 2026-11-18, chief's decision C107, accepted as worded (booking-next's proposed known limitation 2; not the user's words), on the condition that the traveller's own bookings hold no such field.

### A place's name at its start and its address at its end draws the address as a Drop-off line
- **Kind:** known limitation.
- **What the traveller sees:** a stay checked in at "Hotel Aurora" and checked out at "1 Test Street" (or "Hotel Aurora, 1 Test Street") shows that as a Drop-off line under "Place: Hotel Aurora"; its check-out row stays at the hotel. A car picked up at "Airport lot" and returned to "Airport lot, 9 Other Road" shows that Drop-off line and returns there on the Plan, without the lot's pin. Nothing is lost (before booking-time-next the address was dropped when it came with the name).
- **Why:** the write compares nothing (`unalias`, `src/core/bookings.js`: comparing an end's place with the booking's on the write alone was the state every finding of booking-next needed); the readers hide only a drop-off that says nothing the place doesn't (`dropsAtPlace`), and completing the place from the drop-off would be a second place deciding the same thing.
- **Revisit when:** a real model writes a booking this way (seen so far: a stay as strings with a top-level name and address; a car with the same place at both ends).
- **Approved:** 2026-11-18, chief's decision C111, "accept" (booking-time-next's proposed known limitation; not the user's words).

### A booking saved by an older annai keeps what it wrote
- **Kind:** known limitation.
- **What the traveller sees:** saved before 2026-11-17: a ferry, bus or coach saved as `other` with no ride item ends "Ends · …" at its port with a leg from there (its details say Starts and Ends); a stay written with Arrival and Departure keeps its check-in and check-out swapped; a flight's arrival written with no zone of its own keeps the departure's zone. Saved before 2026-11-18: a flight given a leg with no time of arrival keeps its end at the leg before it, so its Arrives line and the Plan's arrival show the earlier leg's time until Shiori writes its legs or its end again (the traveller's own trace, 2026-10-18 to 11-17, holds no such write: its two flight writes give each last leg its arrival). Telling Shiori the right kind or time fixes each.
- **Why:** nothing rewrites a stored booking (booking-next, 2026-11-17, fixed these on writing); a repair that rewrites stored bookings is a migration with its own risks, for shapes no booking seen has.
- **Revisit when:** a traveller has one; the fix would be a one-time repair when annai opens the trip.
- **Approved:** 2026-11-18, chief's decision C108, accepted as worded (booking-next's proposed known limitation 3; not the user's words). Widened to the flight saved before 2026-11-18 the same day: chief's decision C112, "widen it" (booking-time-next's second question; not the user's words).

### A restaurant or an event written with only an arrival is on no day of the Plan
- **Kind:** deferred.
- **What the traveller sees:** a restaurant or an event that Shiori writes with `arrive` or `arrival` and no other time (`{ kind: "restaurant", title: "Test Bistro", arrive: { at: "2026-11-20T18:30", location: "Test Bistro" } }`) is stored as an end with no start, as on main: its details say "Ends: Fri, Nov 20, 6:30 PM" and "To: Test Bistro", and the Plan lists the booking under "Not on a day". Written beside a time that starts it (`start`, `depart`), the arrival ends it, as it should (a tour booked as an event departs and arrives back); a patch's arrival is an end too. A stay's arrival is its check-in, and a car's or an `other` booking's an end, as before. The same for what she is unsure of: a restaurant's or an event's `unsure` that names a time by another name than `start` or `end` (`departure`, `arrival`, `checkin` and the rest) marks nothing unless a detail has that name, so a time she says she isn't sure of carries no check when its time was written another way (as `start` or `end`, in an earlier write, or by the user); a name given beside its own alias in one write is renamed there and marked, as before (every other kind reads those names as its start or its end: `checkOf`).
- **Why:** a write can't tell what a booking's start stands for: a table's arrival, or a tour's departure. booking-time-next built it (item 4: a restaurant's or an event's arrival alone is its start) and it moved stored starts in two review rounds: a patch's arrival moved or cleared a start it could not see, and when that was narrowed to whole writes the same word was a start in a write and an end in a patch, so a restaurant moved with the word it was written with kept its old start while the new time became its end, and an `edit` hint read the booking a third way. It came out of the branch; the design check had proposed it as its own change.
- **Revisit when:** kind-next's real-model run (U80) shows how Shiori writes a restaurant or an event. Then either a skill line that asks her to write such a booking's `start`, or a rule that reads the stored record's own word for what its start stands for. The same run shows whether a restaurant's, an event's or an `other` booking's arrival that names its own place (`arrive: { at, location: "Test Bistro" }`) matters: it draws "To: Test Bistro" under "Place: Test Bistro" (a true line, nothing lost); the fix would be in the details' reader, which hides a drop-off that names the place and could hide this (`src/ui/format.js:310`), not in the writer.

### A single flight given as `flights` (not a list) in a whole write gives no times and says nothing
- **Kind:** deferred.
- **What the traveller sees:** Shiori writes a flight with its one leg as the `flights` value itself, not as a list of one (`{ kind: "flight", flights: { flight: "AS 1", departure: { at, tz }, arrival: { at, tz } } }`, or `flights: "AS 1 SEA-ANC 2026-11-25 06:00"`). It is stored with no start and no end, the result says only "Wrote …", the details draw the Flights line, and the Plan lists the booking under "Not on a day". A one-leg list, and a lone value under `flights+`, give the times. The same on main. In a patch the lone value moves no time either: a flight whose times are set (written as a list, or by the user), patched with a new lone leg (`flights: { flight: "AS 3", departure: { at, tz }, arrival: { at, tz } }`), keeps the old Departs, Arrives and Plan day beside the new Flights line, and says nothing. A lone object patched onto a booking whose legs are a list replaces every leg, silently (a merge patch replaces a list). Also on main. What she is unsure of on a lone value marks nothing: a flight written with a lone leg and `unsure: ["departure", "arrival"]` (or with a lone text leg and `unsure: ["departure"]`) draws the Flights line with no check, and her read result names nothing to check, where the same `unsure` on a one-leg list checks Departs and Arrives; the lone value gives no start or end for her names to mark. A top-level `tz` beside a lone value is refused ("tz" isn't a booking field).
- **Why:** only a `+` key's lone value is read as one leg (`unalias`, `src/core/bookings.js`), so a lone value under `flights` gives no legs, no times and no note. The writer sees the patch, not the leg the store will hold (a merge patch puts an object into a stored object key by key), so a lone value can't be read right from the write alone.
- **Revisit when:** the next version (kind-next's real-model run, U80, shows whether Shiori writes a lone leg). booking-rest-next built the one-line fix, `Array.isArray(own[fk]) ? own[fk] : there(own[fk]) ? [own[fk]] : []`, and it drew a finding in each of two review rounds from the one cause above, so it came out of the branch. Round 0 read a patch's partial object (`{ flight: "AS 2" }`, or only a departure or only an arrival) as the whole leg: refused for its missing departure, or the stored arrival removed with a false note. Round 1 read a patch's lone value as no leg: a flight written with a lone leg and patched with a new one kept its old Departs, Arrives and Plan day. The fix is to read a lone value as the leg the store will hold, in a whole write and in a patch: `mergePatch(stored fields.flights, the patch's value)` (`src/core/patch.js`), the stored leg passed to `unalias` from `ownOf` (`src/plugins/files/index.js`) as the kind already is. The re-review tried it, about 8 lines, in a scratch copy (77 of 78 booking tests passed; the one that failed asserted the old start): a patch with a new lone leg then moves the times, and a partial one moves only what it gives (no refusal, no `NO_END` for a part that gives no arrival). One way for a patch's text leg: it clears the stored end and says so (`NO_END`), as a list does. In the tried lines `part` is true for any lone value in a patch, so text kept the stored end and said nothing ("Arrives 8:00 AM" stays beside a leg with no arrival, the shape round 1 found, also on main), so the fix makes `part` true only where the merge keeps part of a stored object (an object into an object), not for text (an object over a list of legs is the call below). Read `NO_LEGS` from the patch's own value: read from the merged leg, as the tried lines do, a stay or a car patched with a partial lone leg over a stored timed leg is told it on every patch. A blank `flights+` value is no leg already (this branch keeps the stored end; main removed it, saying the last leg gave no arrival), so the fix needs no rule for it. Her unsure times on a lone object then mark Departs and Arrives through the start and end it gives, as on a list; on text they mark only the times the booking keeps (in a patch, its stored start). Its costs, named: a lone leg whose departure has no zone (in a whole write, or in a patch with no stored leg to give one) is refused and she writes it again with the `tz`; a lone bare object with no departure (`flights: { flight: "AS 1" }`), which main takes silently, is refused in a whole write as a list's bare first leg already is; a top-level `tz` beside a lone object leg is then its departure's zone (it is refused now: "tz" isn't a booking field), and beside a lone text leg it is dropped with nothing said, as beside a list of text legs on main (run: stored with no `tz`, no note of it), which loses the traveller nothing, as no time is there for it to belong to; and the code grows, so the size budget is re-measured. The lone object over a list of legs is its own call there: refuse it in `shioriBooking`, which sees the stored record ("flights is a list of legs here: give all of them as a list, or add one with flights+"), or read it as `flights+`. Its tests: the object (start and end set, the Departs and Arrives lines, a Plan row), the text (the first leg's note and `NO_END`), a patch's text leg over a stored end (the end cleared, `NO_END`), the bare object (refused), a lone leg written and then patched with a new lone leg (the times move), a departure-only and an arrival-only patch with no `tz` (the stored leg's zone), and the lone object over a list.

### A closed annai can say "Leave soon" for an item at the destination, timed before the flight that gets the traveller there
- **Kind:** known limitation.
- **What the traveller sees:** with live mode off, or the phone's last position a flight away (at home or at the departure gate), the push relay holds a "Leave soon" copy for a fixed item at the destination other than a stay (a car pick-up at the arrival airport, a meeting), half an hour before the item. If the plan times it before the last flight there lands, the notification comes while the traveller is at the hub or in the air: "Leave soon: Car pick-up at 16:00, Car hire desk." (no minutes). That holds when the flight is flexible, or fixed and starting after the item's time. The reminder waits only for the flight before it in the plan, not for the one that takes the traveller there. When that flight is fixed and starts before the item's time, it is the flight before it in the plan, and the wait runs past the item's time: a fixed flight 14:00 to 17:00 and the car at 16:00 give no copy at all.
- **Why:** a position a flight away counts as none, so the copy is counted from the plan's stop before or the half hour (leave-far's F1, so the closed annai still says it at the destination); the wait for a landing is the fixed flights and trains before the item in the plan, and the plan can't tell which flight takes the traveller to it.
- **Revisit when:** a traveller reports a "Leave soon" for a destination item before they flew, or the plan comes to know which flight takes the traveller to an item. A look-ahead to the next fixed flight or train after the item, holding the copy until it lands, was weighed (about 8 lines in `planWatches`) and not built: it adds rules to the part that took four fix rounds, and for a real appointment the push is true (the traveller will miss it). The design check of 2026-11-17 recommended no look-ahead.
- **Approved:** 2026-11-17, chief's decision C91 (the leave re-review's proposed known limitation 5, accepted as worded; not the user's words).

### A train, bus, coach or ferry arriving under 2 hours before a flight is read as a connection to it
- **Kind:** known limitation.
- **What the traveller sees:** a train into a city station, a change between two airports, or an airport bus, coach, train or ferry that arrives under 2 hours before a flight is read as a connection to that flight, so the flight gets no leave reminder and no "Running late" from it. A train into a city station at 10:30 and a flight at 12:00 from an airport 50 km away loses a true "Running late … About 66 min away". Since leave-next (2026-11-17) buses, coaches and ferries carry the traveller as trains do, so they read the same way.
- **Why:** a plan item stores one place, so annai can't tell an airport station from a city one. Without the connection rule the commoner shape (plane to plane at one airport) would get a false "Running late". Storing where a carrier arrives was weighed in the design check of 2026-11-17 and not taken: it adds state, a stored-format change and a new miss.
- **Revisit when:** plan items come to store where a carrier arrives for another reason, or a traveller reports a missed leave reminder of this shape.
- **Approved:** 2026-11-17, chief's decision C91 (the leave re-review's proposed known limitation 2, accepted as worded; not the user's words).

### A position more than 1000 km from an item gets no leave reminder until it comes within 1000 km, then "Leave soon" with no minutes
- **Kind:** known limitation.
- **What the traveller sees:** with a position more than 1000 km from a fixed item (mid-air on a flight missing from the plan, or on a road trip of over 1000 km), annai gives no leave reminder for it; when the position comes within 1000 km, "Leave soon" comes with no minutes, and with it "Running late … About N min away" (seen: "About 1053 min away").
- **Why:** the 1000 km cap is what stops a reminder to leave home for a hotel a flight away (the user's report of 2026-11-16); with no flight in the plan, annai can't tell a plane from a long drive.
- **Revisit when:** annai reads a position in the air (the trace's speeds in flight, after the trip), or a traveller reports the shape.
- **Approved:** 2026-11-17, chief's decision C91 (the leave re-review's proposed known limitation 3, with the design check's "Running late" line, accepted as worded; not the user's words).

### The Driving strip during a flight lists the destination's stops, with car times
- **Kind:** deferred.
- **What the traveller sees:** a phone at flight speed counts as moving fast, so Driving takes over, and the strip lists the stops ahead that are within a day's drive of the plane's position, with a drive's minutes. On a plane 804 km from a tour at the destination, 40 minutes before it lands: "Old Lighthouse, 804 km, 858 min". Since carrier-rows-next the strip drops the flight's own airport once it departs, so these are the stops it lists in the air. Reminders are not affected: a fixed item after a fixed flight waits for it to land.
- **Why:** the strip (`routeStrip`, `src/core/now.js`) has no notion of a carrier that has not landed; the reminders have (`landed` in `planWatches`).
- **Revisit when:** the next version, as its own change: the strip leaves out a stop after a fixed flight or train that has not landed, by the way the reminders wait for it (its end, else its start), with a test.

### With another app in front, annai only sends its time reminders, as notifications
- **Kind:** known limitation.
- **What the traveller sees:** with another app in front of annai (a navigation app while driving) or the phone locked, annai doesn't follow the phone's position, give place reminders ("arrived", "nearby", "running late") or speak: Shiori and Koe are quiet until annai is back on screen, and then catch up. Only its time reminders reach the traveller, as notifications through the relay: Shiori's reminders for a time, and the itinerary's "coming up" and "leave soon" ("leave soon" counted from where annai last saw the traveller). With Driving Focus on, iOS silences those too (it has no list of allowed apps): they come with no sound or banner until it ends. Driving Focus can be set to turn on by itself or only by hand (Settings → Focus → Driving). On an iPhone, annai's Settings → Notifications says that it silences them (src/ui/screens/notifications.js), and no more: whether it turns on by itself is the traveller's choice.
- **Why:** an iPhone web app gets no position or microphone in the background (the Geolocation spec gives positions only to a visible page; a Home Screen app loses the microphone when another app is in front), and picture-in-picture doesn't start from a Home Screen app (WebKit bug 303885, open). Only a native app could keep them. Driving Focus has a list of allowed people and none of allowed apps (Apple's "Use the Driving Focus on your iPhone", support.apple.com/108384, read 2026-11-17), so annai can't be added to it. (An iPhone with Apple Intelligence also has an Intelligent Breakthrough & Silencing switch there that lets important notifications through; whether iOS ever counts a web app's reminder as one is not known.)
- **Revisit when:** WebKit lets an installed web app keep its position in the background, or a native shell is built.
- **Approved:** 2026-11-17, the user's pick "Notifications, made solid (Recommended)" (through chief). The option said to allow annai in Settings → Focus → Driving; Apple's pages show no way to allow an app there, so the screen says only that Driving Focus silences annai's reminders, and gives no advice on turning it off (a safety feature: the main session's call, 2026-11-17).

### A stay's check-in timed before the traveller can get there, with no position near the trip
- **Kind:** known limitation.
- **What the traveller sees:** with no position near the trip (live mode off, or the phone closed since home), a stay's check-in item timed before the traveller can get there makes the reminders after it come hours early, naming a long drive (for a stay 420 km on, "… About 455 min by car": `travelMinutes` in src/core/live/geo.js for 420 km), or late: after a flight under 1000 km that leaves after the check-in time, the next morning's first item up to about 40 min late and the flight home up to about 1 h 45 min late; after a landing, the next item counts from the stay, not the airport. None of it happens with a position near the trip. On a plan made before the fix below, moving the check-in item's time after the landing fixes it.
- **Why:** an item's time is not when the traveller is there: a check-in is an earliest time, and the plan sorts it as an appointment, so with no position the reminders after it count from the stay as the stop before. No stored field tells a traveller who checked in at 15:00 from one who arrives at 21:00. Storing a check-in as an earliest time would be a design change (the leave design check, 2026-11-17).
- **Revisit when:** the planned fix: Shiori times a check-in item when the traveller gets there (one line in the plan-a-trip skill), after a real-model run shows she follows it.
- **Approved:** 2026-11-17, the user's pick "Accept as a known limitation (Recommended)" (through chief; the leave re-review's proposed known limitation 1, with its "late" sentence as corrected by leave-next's final review).

### A flight after a flight, with the phone closed, gets "Leave soon" when the first lands
- **Kind:** known limitation.
- **What the traveller sees:** with the phone closed (no position), a flight that follows a flight in the plan gets "Leave soon" when the first lands (half an hour before the 2-hour aim, floored at the landing): a false alarm at a same-airport layover, useful if the traveller left the airport. A connection too short for the 2-hour aim gets nothing, by design.
- **Why:** with no position annai can't tell a traveller waiting at the gate from one who left the airport. Giving the second flight no leave reminder without a position would miss the traveller who left.
- **Revisit when:** a traveller reports the false alarm at a layover as a bother, or annai comes to know where the traveller is after a landing.
- **Approved:** 2026-11-17, the user's pick "Keep as built (Recommended)" (through chief; the leave re-review's proposed known limitation 4).

### A share sent to "New conversation" whose add stops partway lands in two conversations
- **Kind:** known limitation.
- **What the traveller sees:** the files kept before the stop (storage full, say) sit in a first conversation, named after its first file, which the share screen doesn't open; Shiori's note for them is written there and she answers it when that conversation is opened. "New conversation" again puts the rest in a second one. Nothing is doubled or lost (before share-retry-next, the second held the whole share and the first a doubled part).
- **Why:** keeping the share together needs a record of which conversation the failed add used, and an "Add to it" button, for a rare path (an add that stops partway, sent to a new conversation).
- **Revisit when:** someone meets it, or the share screen offers conversations without dates.
- **Approved:** chief's decision, 2026-11-17 (C102; not the user's words), on the proposal "Accept it as a known limitation (Recommended)".

### A page closed in the middle of adding a share adds the files it had already kept again
- **Kind:** known limitation.
- **What the traveller sees:** a long share (many photos; on Android a page sent to the background can be closed) is on the share screen again after the page reopens, and adding it keeps the files kept before the close twice ("photo (2).jpg"); nothing is lost, and each file is read and told to Shiori once. Older than share-retry-next.
- **Why:** taking each file out of the inbox the moment it is written would lose its calendar import and Shiori's note on a close (worse than a copy); doing those per file would wake Shiori once per file.
- **Revisit when:** the traveller sees such copies after a long share.
- **Approved:** chief's decision, 2026-11-17 (C103; not the user's words), on the proposal "Accept it as a known limitation (Recommended)".

### A Japanese name written in old kanji forms reads as Traditional Chinese
- **Kind:** known limitation.
- **What the traveller sees:** a line of kanji alone in an old spelling (國, 會, 來, 點 …), such as 國學院大學, 靖國神社 or 東京會館, is Chinese by its writing (detector-next): its screen tag draws it in Traditional Chinese glyph forms; with English and Japanese listed, the phone's voice reads it in Japanese (Han placed as none of the traveller's languages is read as Han that says neither), with Chinese listed too or on a Chinese phone in the Traditional Chinese voice. A line with any kana, or a modern spelling (国, 会), is Japanese as before; no line of annai's own Japanese has one (0 of 2,622).
- **Why:** those forms are what tells Traditional Chinese from Japanese in a line of kanji alone; taking them out would make Traditional Chinese lines with no other sign read as Japanese, which is more common for a Chinese reader than an old-spelling name is for a Japanese one. A list of old-spelling names would grow forever.
- **Revisit when:** a traveller sees such a name read in the wrong voice.
- **Approved:** chief's decision, 2026-11-17 (C101; not the user's words), on the proposal "Accept it as a known limitation (Recommended)".

### A plugin download or update check that pauses for more than 20 seconds is cut
- **Kind:** known limitation.
- **What the traveller sees:** on a working but stalling connection (a tunnel, a cell handover) where nothing at all comes from annai's site for 20 seconds in the middle of adding a provider or a plugin, the add ends with "The plugin couldn't be downloaded. Check the connection and try again."; tapping again installs it (the files already in come from the browser's cache). Not checked, and possible: the same when the plugin's answer waits behind annai's own update download on a slow link. Since addr-limit-next (2026-11-18), the same 20 s of a site's silence ends Get it, an Update and the update checks of a package from an address, also on a site that takes more than 20 s to start answering (a host that sleeps until asked: not measured): "‹site› stopped answering. Check the connection and try again."; tapping again goes on. And annai's own check for a new version of itself has 20 s on the whole request: a slow working link whose first answer takes longer shows "annai couldn't check for a new version of itself. Check the connection and try again." while the browser goes on with the update.
- **Why:** any time limit on a dead connection cuts a pause longer than itself (`QUIET_MS` in `src/core/answer.js`, dl-limit-next, 2026-11-17); 20 seconds is about twice the slowest cold start measured on a real slow link, and a longer number holds a dead connection as long.
- **Revisit when:** a traveller reports a failed add on a working connection; then measure real stalls on a phone and size the number from them.
- **Approved:** 2026-11-18, chief's decision C106, accepted as worded (dl-limit-next's proposed known limitation; not the user's words). Widened to addresses and to annai's own version check the same day: chief's decision C113, "widen it to both" (addr-limit-next's builder and its second re-review; not the user's words).

### A recorder that stops sending sound in the middle of a line keeps the microphone open
- **Kind:** deferred.
- **What the traveller sees:** with recording (not phone dictation), the phone's audio capture stops delivering sound while someone is speaking, with no error (the browser's audio thread stalls, or the system takes the microphone without telling the page): the dock stays on "Hearing you" and the microphone stays open, since as far as annai can tell someone is still speaking; a tap's 8 s, her own listening's time and the window after she spoke all wait for that line to end. A tap closes it. From reading the code (the tap-listening design check, 2026-11-18); not seen on a phone. Main before tap-ear-next did the same.
- **Why:** the timers of a tap's window, of the window after she spoke and of her own listening are not armed while someone speaks, so that a line said across them is heard to its end (once her own listening's timer has fired, no speech holds it), and "someone speaks" ends only with the line's segment or a click's end, both made from the recorder's sound. The browser plugin watches for the capture's first frame only (`src/plugins/voice-browser/index.js`), not for frames that stop coming later. A watch in annai's own timers would break their rule (a line is heard to its end); the fix belongs in the plugin, which knows its frames, and how long a pause in frames means a stall needs a measurement on a phone.
- **Revisit when:** the next phone measurement of the microphone plugin (frame gaps under load, a call coming in, the screen locking); the fix then: the plugin reports a capture that stops sending frames in the middle of a line as a microphone failure (`onError`), after a pause sized from that measurement.

### The test kit waits 100 ms after closing a test's server, for a Node mock-clock bug
- **Kind:** deferred.
- **What the operator sees:** nothing in annai; the unit tests that use `siteOn` (test/unit/dead-kit.js) take about 100 ms longer each.
- **Why:** Node v26.13.1's mock clock drops a timer of the next test when a timer of the previous test is cleared late (Node's fetch can clear one after the next test's fake clock starts); the wait lets the previous connection end first. Reported upstream from the user's account as https://github.com/nodejs/node/issues/67593 (2026-11-18).
- **Revisit when:** a Node release with the fix is the one the tests run on: take the wait out, and run the tests that use `siteOn` many times side by side.


### A tap uses up what was typed before it in a field that only a button saves
- **Kind:** known limitation.
- **What the user sees:** any tap on a button or link, even one that changes nothing (a fold, a chip, Show, Remove's first tap), counts as done with what was typed before it in a field that only a button saves (searches and settings that save themselves are kept). If the screen refreshes after that tap (the tap's own result, or an earlier action still working), that text goes, with any error the tap showed. Examples: a model id typed, then Save on the address form above it: the id goes; Refresh tools started and slow, a new server typed, Add server tapped and refused while the refresh still runs: when the refresh ends, the refusal and the typed server are gone. Text typed after the tap is kept through refreshes until the next tap uses it up; a move nobody asked for (Driving taking over at a drive's start) still replaces the screen. The app before form-keep-next lost more in each case, what was typed after the tap too. The user's words this narrows: "The plugin form's redraw can lose a typed address on a slow phone" (the project's notes, 2026-11-09); the no-jumps rule (the timeline spec: the screen never changes under the traveller's hands); "what I prefer is simple and robust solutions" (2026-11-12).
- **Why:** the shell can't tell which fields a tap's action used. Scoping a tap to its own form needs every form to be one panel (nothing checks it), or every caller to say what it used (the per-caller guard form-keep-next removed), and would only move the loss into the next entry: a Save on the address form would wait for a model id typed before it, its "Saving…" and toast with it.
- **Revisit when:** a traveller reports text lost this way, or forms get a structure the shell can read.
- **Approved:** 2026-11-18, chief's decision C116 (not the user's words), accepted as worded in form-keep-next's touch report.

### A screen refresh that waited for the traveller shows late, or not until the next one
- **Kind:** known limitation.
- **What the user sees:** a refresh a tap asked for (Refresh tools, Turn on, Update, Back up now, a key Save) waits while the traveller types or works in a field after that tap; if their next tap does not itself refresh the screen (a fold, a chip, Remove's first tap), the refresh is dropped, and what it would have shown (the refreshed tool list, the plugin now on, "Backed up.", a model just added in the list above) appears at the next refresh of that screen or when they come back; a key Save's "Saving…" and its toast wait the same way. Buttons and busy words a screen set for its own work come back as the work ends (Update says "Updated"; a listed model's Add says "Added", or "Already added" when refused, while the list above doesn't show it yet). A refresh annai makes on its own (a plugin finishing its start, a page a plugin adds, an update found) waits while text typed in a field that only a button saves is on the screen, even erased (Add's address, MCP's new-server form, a model id on a provider's page, a backup place's fields before Save and test, a trip's name and dates before Save, Shiori's instructions before Save, the Erase box, a plugin page's own fields, and selects with their own change handlers: Languages, Simulate and Replay speed, Trace filters), until a tap that refreshes or a move. The plugin searches are kept across refreshes; a provider page's model filter and its fetched list, which save nothing, go when the screen refreshes. The app before form-keep-next refreshed at once and lost what was typed. The user's words this narrows: "The plugin form's redraw can lose a typed address on a slow phone" (the project's notes, 2026-11-09); the no-jumps rule (the timeline spec: the screen never changes under the traveller's hands); "what I prefer is simple and robust solutions" (2026-11-12).
- **Why:** every way to show it sooner loses the typing (refreshing at once, as before), undoes the next tap's own result (landing a dropped refresh after it: a refused Add server's error, Remove armed), or copies the work into the new screen (built and dropped after nine wrong shapes); form-keep-next's step back found the wait needed (without it, 9 and 5 of 17 shapes fail).
- **Revisit when:** a traveller reports a stale state, or "On, but it didn't start" after a plugin started; or a plugin gets a way to say its field is saved.
- **Approved:** 2026-11-18, chief's decision C117 (not the user's words), accepted as worded in form-keep-next's touch report.

### A model added by hand before annai described it never takes annai's description
- **Kind:** known limitation.
- **What the traveller sees:** a model added by its id (or from the provider's list) before an update of annai describes the same model in the provider's plugin stays as the traveller added it: annai's prices, context window and tool words never reach it, and removing it doesn't bring annai's version either (only removing the provider and adding it again does). Its calls may then count nothing toward Spend per day until prices are typed on its page (read from src/core/llm/cost.js, not run).
- **Why:** the sync skips a description model the ability already has by its provider model id, as it skips one the traveller removed (models-next: one model per provider model id). Taking the description's values into the traveller's model would lay the stale copy of the defaults over what they gave it and rename the model under them.
- **Revisit when:** a traveller reports a hand-added model with no prices, or Spend per day missing its calls.
- **Approved:** 2026-11-19, chief's decision C119 (not the user's words), accepted as worded in docs/progress.md's question from models-next's Fable final review.

### A removed description model comes back when an update drops it and a later one lists it again
- **Kind:** known limitation.
- **What the traveller sees:** the traveller removes a model a provider's plugin describes; a later update of that plugin no longer lists it, and a still later one lists it again: it comes back on the provider's page. Probed on main and on models-next. annai's own plugins don't drop a model and list it again, so only a third-party plugin can do this.
- **Why:** the marks of what the traveller removed live in the last update's list of described models, so a key missing from one update loses its mark. Keeping removed keys in a list of their own is one more stored list, a design change for a case annai's own plugins never reach.
- **Revisit when:** a third-party plugin does it, or a traveller reports a removed model coming back.
- **Approved:** 2026-11-19, chief's decision C120 (not the user's words): accepted as a known limitation, third-party plugins only.

### A line said as another conversation is opened is let go
- **Kind:** known limitation.
- **What the traveller sees:** classic voice, her microphone open. Someone is still speaking into it, or (with a quick-decision model) a line just said is still being judged, when the traveller taps another conversation, +, Remove, or Open on annai's "Carry on in …?" card: the line is not written anywhere, and nothing is said about it when they come back; they say it again. A line that reached her before the tap is in her turn, which "A turn stops when another conversation is tapped" covers. When the conversation they tapped fails to open (a storage error), the microphone closes too: a line said into it after the failure is not heard, the card says the other conversation didn't open, and the next tap listens.
- **Why:** a line belongs to the conversation it was heard in, and their tap stopped that conversation. Keeping it for their return was built and drew findings in every review round (its write had to be ordered against the stopped turn's end, the move's record and a removal, and Remove waited for every line still being judged); letting it go keeps the user's pick "Nothing; I just answer" true as written. A microphone made while an open runs belongs to that open, so a failed open closes it rather than leaving it with no end.
- **Revisit when:** a traveller loses a line this way and minds.
- **Approved:** 2026-11-19, chief's decision C122 (not the user's words), the option "Let it go (Recommended)"; the failed open's clause, chief's decision C123 (2026-11-19, not the user's words), as the approved "A turn cut by a failed open doesn't resume on its own" already closes the microphone there.

### A fetched model list stays after its connection changes, its Adds refused
- **Kind:** known limitation.
- **What the traveller sees:** on a provider's page, after the address, key, headers, key header or list path change (a plugin's sign-in included), the model list fetched before stays on the page until a Fetch lists again or the page is drawn (a Fetch that fails, such as one the new server refuses, leaves the old rows); its Add buttons add nothing and say "This list is from before the address or key changed. Fetch the model list again."
- **Why:** taking the list off the screen at each change was the drop models-next built, where three review rounds found problems, and it covered one of the five ways a connection changes; checking the connection where the list acts (a row's Add) covers all of them (model-list-a-next, the step back's design check, option A).
- **Revisit when:** a traveller reports rows that did nothing.
- **Approved:** 2026-11-19, chief's decision C124 (not the user's words), "Accept as a known limitation".

### A mostly-Latin line of hers with a few Han characters takes the screens' glyph forms
- **Kind:** known limitation.
- **What the traveller sees:** a line of Shiori's that is mostly Latin words with a few Han characters (「我在 Old Town」, 「明日10:00 Museum of Odd Clocks」, an option or a card's title) is tagged as Latin text: its Han characters are drawn in the screens' glyph forms, and a screen reader reads it by the screens' language, while the phone's voice reads it in the language of her reply so far. The same as before voice-reply-next.
- **Why:** telling such a line's language needs a rule of its own and its own measurement (a quick probe of a reviewer's read "Where is 新宿御苑?" as Chinese), for a small visual difference; the tag never guesses Latin text, so a wrong guess can't give it a wrong voice.
- **Revisit when:** a traveller reports wrong glyph forms or a screen reader's voice on such a line.
- **Approved:** 2026-11-19, chief's decision C125 (not the user's words), "Accept as a known limitation (Recommended)".

### A Han-only line with nothing before it can be drawn in one language and spoken in the other
- **Kind:** known limitation.
- **What the traveller sees:** with the screens in Japanese or Chinese and the other listed first in Settings → Languages, a line of Shiori's of Han characters that say neither Japanese nor Chinese, with nothing before it in her reply to tell, is drawn in the screens' glyph forms and read by the phone's voice in the first listed: 「大家好」 on Japanese screens with Chinese listed first is drawn in Japanese forms and read in Chinese; 「東京駅」 on Simplified Chinese screens with Japanese listed first is drawn in Chinese forms and read in Japanese. With her reply before the line, both follow her reply.
- **Why:** each reader keeps its own default, as before voice-reply-next: the tag the screens' language (what the page draws with no tag), the voice the language listed first. One rule for both changes something with its own reason: the tag following the order changes the glyph forms of the traveller's own Han-only lines and trip names on such screens (voice-reply-next's first build did, and it was taken back); the voice following the screens reads such a line in a language they didn't list first. No measurement favours either: none of her recorded sentences reaches this rule.
- **Revisit when:** a traveller with Han screens and the other Han language listed first reports it.
- **Approved:** 2026-11-19, chief's decision C126 (not the user's words), "Accept as a known limitation (Recommended)".

### After a turn in which Claude thought and read something large, the next turn pays to write that turn again
- **Kind:** known limitation.
- **What the traveller sees:** nothing on screen; in Trace, the next turn's first step writes the turn before it to the provider's cache again, at the write price. Claude's thinking and each step's now block (the time, place and state it was sent with) stay in a turn's requests only within that turn, so the next turn's request matches the cache only up to where the turn before began. About $0.08 a turn on Opus after a 10,000-token tool result, $0.36 after 44,000. In 26 days of real use (the model calls traced from 2026-10-22 to 11-17), about $1.3 to $1.4 of $13.47 on Opus (about 10%), most of it in 7 turns that followed a big read.
- **Why:** it follows from keeping Claude's reasoning "within a turn" and from "Defer, do it next" (2026-10-28). Each fix costs more than it saves or takes something away: stopping her reasoning after a big read (saves about $0.9 in those 26 days), keeping it across turns (nets $0.1 to $0.8, and a reload then writes the whole conversation again), or dropping it altogether.
- **Revisit when:** a week of a trip's use shows these writes at over 20% of Claude's spend, twice their share in the 26 days measured (big reads have become routine, not a few turns), or Trace shows one such write over $1.
- **Approved:** 2026-11-19, chief's decision C128 (not the user's words), "Accept it (Recommended)".

### An undated conversation's list of your other conversations follows only a cold cache or another refresh
- **Kind:** known limitation.
- **What the traveller sees:** in a conversation with no dates whose cache is warm, Shiori's "Happening now" and "Their latest other conversations" are as they were when its snapshot was last taken (up to an hour), so a trip started or renamed since isn't in that list. She can still find any trip with `list_trips`, and any refresh (a personality change, the traveller's own edits, dates) brings the list up to date.
- **Why:** a rewrite for each trip change elsewhere would cost the whole cached conversation, as her own edits would.
- **Revisit when:** a traveller reports her missing a trip they just made.
- **Approved:** 2026-11-19, chief's decision C132 (not the user's words), "Accept (Recommended)".

### When Shiori changes her personality, the next turn writes the whole conversation to the provider's cache again
- **Kind:** known limitation.
- **What the traveller sees:** nothing on screen; in Trace the next turn's first step reads nothing from the cache and writes the whole request, for both halves: about $0.20 at 30,000 tokens on Opus, $1.40 at 175,000, $0.05 more for Koe. 3 times in 26 days of real use (on two days).
- **Why:** a change of hers applies at her next wake (spec §14.1, "An approved change applies at her next wake, never mid-conversation"), and the personality sits before every cache mark, so any change to it rewrites what follows; applying it only once the cache is cold would leave it unapplied for as long as the traveller keeps talking.
- **Revisit when:** tunes come more than once a week in real use, or Trace shows one over $1.
- **Approved:** 2026-11-19, chief's decision C134 (not the user's words), "Accept (Recommended)".

### An edit you make while Shiori is answering waits for a cold cache when she writes the same file in that answer
- **Kind:** known limitation.
- **What the traveller sees:** if they change a trip's dates, party, name or memory in Details or Files while Shiori is in the middle of an answer, and she writes that same file in that answer, she goes on from the version she had until the conversation's cache goes cold (up to an hour). A name they gave reaches her at once.
- **Why:** a warm conversation follows a file only when the traveller's write is its latest one; telling an older write of theirs from hers would need the file's history read at every wake.
- **Revisit when:** a traveller reports it.
- **Approved:** 2026-11-19, the user: "Accept it (Rec.)".

### annai makes no backup of its own before an update that changes the database's layout
- **Kind:** known limitation.
- **What the traveller sees:** nothing from the layout steps, except that on a long history the first start after such an update can take longer while a new index is built. Backups are the automatic ones to the places they set, a place's Back up now, and the Backup files they export.
- **Why:** the layout steps only add stores and indexes and never rewrite or delete a record (the spec's rule, checked by one browser test with a record in each store from every earlier version), so a backup taken before them holds the same records as the phone after them. Mid-trip, offline or with no place set, a backup to a place couldn't be written anyway; a Backup file can still be built and saved when the traveller asks for one. The one-time changes at start (spec §4.6) are outside this rule.
- **Revisit when:** a database step can't be made without rewriting or deleting records (that change is then a design of its own and a question for the user).
- **Approved:** 2026-11-19, the user: "Rule + one test (Rec.)".

### A save the phone refused for another reason can show the storage card
- **Kind:** known limitation.
- **What the traveller sees:** when the browser refuses a save for a reason other than a full phone, such as a connection to the database lost twice or a damaged database, or a read whose reopen fails the same way after annai's one retry, annai can show the storage card ("There's no room left") on a phone that has room. Nothing saved is lost. Typed words come back to the type box; a spoken line, a tap, or photos or files refused this way are gone, so they say, tap or attach them again after looking for room.
- **Why:** WebKit gives no reason for a refused write, so a full disk, a twice-lost connection and a damaged database look the same at the store's door (src/core/store-idb.js). The other way, the card only for the browser's quota error, leaves a full iPhone with annai's fallback words "The transaction was aborted." and no card, the case this fix is for.
- **Revisit when:** a trace shows the storage card on a phone with room.
- **Approved:** 2026-11-19, chief's decision C130 (not the user's words), accepted as recommended.

### On a full phone, only typed words come back
- **Kind:** known limitation.
- **What the traveller sees:** on a phone too full to write, in the open conversation, a refused spoken line, a tap on one of Shiori's cards, photos or files attached to a typed line that weren't kept, or a pasted chip is gone; the storage card shows, and they say, tap or attach it again once there is room. For the open conversation, typed words always come back to the type box. What happens for a conversation that isn't open is in "On a full phone, what was meant for a conversation that isn't open is dropped with a card, not kept for later"; since quiet-writes-next (2026-11-23) every write nobody waits on that carries something for Shiori or the traveller says so with the storage card too.
- **Why:** a spoken line or a tap has no box to go back to, and photos can't be kept without room; each would need its own place to wait, for a case that needs a full phone.
- **Revisit when:** a traveller loses something that way.
- **Approved:** 2026-11-19, chief's decision C131 (not the user's words), accepted as recommended.

### Two typed lines refused in the same instant come back in the wrong order
- **Kind:** known limitation.
- **What the traveller sees:** on a phone too full to write, two lines sent within the fraction of a second it takes the phone to refuse the first both come back to the type box, the later above the earlier; so do two conversations' lines given back as one conversation is left for another. Nothing is lost, and the box can be edited.
- **Why:** the first comes back from the write that failed and the second from the turn that stopped on it; the box puts what comes back before what it holds. One hand-back per turn would rewrite the part two fix rounds settled.
- **Revisit when:** a traveller reports lines swapped in the box, or typed lines come to be written at send.
- **Approved:** 2026-11-20, chief's decision C166 (not the user's words), accepted as recommended (option a).

### A file sent with a message the phone refuses stays in Files, and the card doesn't say so
- **Kind:** known limitation.
- **What the traveller sees:** when the phone fills between keeping a file and writing its message, the words come back with the storage card and the file's chip is gone; the file is in that conversation's Files, and Shiori hasn't been told of it. Attached again, a second copy is kept; "Ask Shiori about this" in Files sends the kept one.
- **Why:** the file is kept before the message that names it, and a full iPhone refuses a removal too. Giving the chip back needs the files and their conversation carried back with the words.
- **Revisit when:** a traveller reports a file kept twice, or one Shiori never read, after the storage card.
- **Approved:** 2026-11-20, chief's decision C167 (not the user's words), accepted as recommended (option a).

### On a full phone, what was meant for a conversation that isn't open is dropped with a card, not kept for later
- **Kind:** known limitation.
- **What the traveller sees:** on a phone too full to write, for something meant for a conversation that isn't open (a watch's wake, files added, a move's carried lines, or a spoken line, a tap or a note from the other half queued for a conversation they left): typed words come back to the type box; a reminder among it is still shown, and said with voice on; the rest is dropped with a card ("Something for Shiori wasn't saved"; on a full phone the storage card, which says that first). Shiori there isn't told of a watch that fired, of files added (they are in Files), or of a move's carried lines (the originals stay where they were), and a tap or a spoken line is gone, as in the open conversation (a spoken line whose route fails shows the storage card too, since quiet-writes-next). Nothing waits in memory, and no conversation fails to open for it (since tool-result-next, one whose last turn left a tool call open opens too, its repair told and written at its next turn's start); what waited behind a turn the phone stopped gets its own turn at once, except a typed line, which comes back to the box.
- **Why:** C131's: these have no box to go back to. Kept in memory, they made every other conversation fail to open until there was room, and were lost at a restart anyway.
- **Revisit when:** a traveller reports Shiori not knowing of files added, or of a watch that fired, after the storage card.
- **Approved:** 2026-11-20, chief's decision C170 (not the user's words), option (c), rewriting C168 (option a, kept waiting).

### After Open on annai's card, when that conversation doesn't open, the chat still says it moved
- **Kind:** known limitation.
- **What the traveller sees:** the card "That conversation didn't open", and in the chat the line "Shiori moved this to Kyoto.", a link to it (it may show only at the chat's next draw); what was carried is there where the phone takes its writes. Shiori's own record of the call says the conversation is open, so at the traveller's next line in the chat she may speak as if they had moved.
- **Why:** it needs a read the phone refuses while its writes work, not a full phone (on a full phone the line's own write is refused, and the storage card says so, since quiet-writes-next); her call's result can't wait for the open, which waits for her turn to end, and holding the line back on the open's outcome drew a finding in each of three review rounds.
- **Revisit when:** a traveller reports Shiori saying they moved when the open had failed.
- **Approved:** 2026-11-20, chief's decision C171 (not the user's words), option (a).

### On a phone that stays full, a reminder already shown shows again each time its conversation opens
- **Kind:** known limitation.
- **What the traveller sees:** "Leave for the airport by 14:10" shows each time they open that conversation that evening while the phone stays full, with nothing saying it is late (at each start, and at each open of that conversation since owed-leave-next, 2026-11-21); with room again, the next start wakes Shiori once more with the catch-up. A reminder that comes due in the instant annai is being closed isn't shown then. On a phone with room or a full one it shows at the next open too, except where it is missed, in the shapes of "A reminder in the very instant annai is being closed can still be missed" (by reading the code, not checked on a phone).
- **Why:** a firing is remembered across starts only by its entry, which the phone refused, and the one-time watch's file can't be removed either (on an iPhone, by the builder's WebKit probe; not checked on other phones); a second store for it would be a new part. Before storage-rest-next it was never shown at all. A card on a page being left reaches no one.
- **Revisit when:** a traveller reports a reminder repeating with the storage card up.
- **Approved:** 2026-11-20, chief's decision C169 (not the user's words), accepted as recommended (option a); the closing clause, chief's decision C172 (option a); the wording widened to "each time that conversation opens", chief's decision C174 (2026-11-21, not the user's words, option (1)); the clause below, chief's decision C210, 2026-11-23 (not the user's words, Q-N option (1)).
- **Clause (quiet-writes-next's Fable review, 2026-11-23):** on Chromium at no byte free (reads refused too), a watch's reminder that annai showed when its way to Koe's live session failed is said once more when a session next opens: the wake still waits in the session, which couldn't open to let it go. Revisit with the entry.

### At its last bytes, Shiori can take over from a failed live voice without being told her last note never reached the traveller
- **Kind:** known limitation.
- **What the traveller sees:** on a phone at its last bytes, when a note of Kokoro's for the traveller is on its way to Koe's live voice, no session can open and Koe's chat voice rests in the same moment, and the one write refused is Kokoro's block for Koe's state: "Koe's live voice couldn't start" shows and Shiori answers directly, but isn't told that what she last told Koe never reached the traveller, so she may not repeat it (no card: the block is annai's own record; a later refresh with room writes it). With reads refused too (Chromium at no byte free), the notes a closing live session hands on aren't shown (a card says so).
- **Why:** it needs a phone at its last bytes and a rare moment; she answers either way; showing the note's words from that branch would add a second path to what the live route does after its refresh (quiet-writes-next's fix round 1).
- **Revisit when:** a traveller reports Shiori not repeating something she'd said she'd tell them after "Koe's live voice couldn't start" on a nearly full phone; or the user says "show the note's words from that branch".
- **Approved:** 2026-11-23, chief's decision C210 (not the user's words), Q-N option (1).

### A reminder in the very instant annai is being closed can still be missed
- **Kind:** known limitation.
- **What the traveller sees:** a reminder owed when annai was closed or put away shows when that conversation next opens (owed-leave-next, 2026-11-21). Since remind-first-next (2026-11-23) a catch-up's firing is written (`trigger.fired`) a few milliseconds before its wake's `reminder.held`, so a page killed in those milliseconds loses that reminder (main lost it for the whole 15 s wait for a GPS fix). In the very instant annai is being closed, a reminder can still be missed or counted as told: one annai shows by itself in that instant (a wake that fails then, or one that arrives while a live session is open and the page is hidden: its card shows where no one sees it and its entry is written, so it counts as shown; at a start too, the card the open shows waits until the screen is up, a few hundred ms, while its entry is written at once, so another annai tab taking over in that window, or a start that fails right after the open, leaves it unseen and counted as shown); a line of hers still being said as the page goes (counted as told); a first write refused as the page goes (the turn's wake record, so nothing is logged, and the page being left shows no card); and a browser tab that comes back without a new start shows it only when that conversation next opens. A time reminder's phone notification, from the push mirror, may still come.
- **Why:** each case needs the page to go within moments of the reminder. A reminder is settled by its entry, written right after its card whether or not anyone saw the card; a fix is a new write path at the moment the page dies, where writes are least sure, or settling on display, which needs the screen to write the log (a second writer of the rule).
- **Revisit when:** a traveller reports a reminder that never showed after closing annai, outside these shapes, or the trace shows one; or the user says "write the reminder down before leaving", and annai builds that option, or "the entry follows the screen" for the start-up cases.
- **Approved:** 2026-11-21, chief's decision C173 (not the user's words), option (1): "the very instant annai is being closed" accepted as one known limitation entry with a README clause; the two start-up cases under its first shape, chief's decision C175 (2026-11-21, not the user's words, option (1); to undo: "the entry follows the screen"); the catch-up's few milliseconds, chief's decision C214 (2026-11-23, not the user's words, Q-Q option (1); to undo: "hold before the firing is written").

### With Koe · Realtime, an urgent reminder can count as told by a card already on its way
- **Kind:** known limitation.
- **What the traveller sees:** with Koe · Realtime (Gemini Live, and OpenAI Realtime, not used yet), an urgent reminder (or, by the code's reading, Kokoro's immediate note for the traveller, which goes in the same way) that fires within about one network round trip of a card or question of Koe's already on its way, where that call is the first thing of her turn to arrive, counts as passed on; if her answer is then only a bare word, or the session drops, it isn't shown, then or at the next open.
- **Why:** found by remind-first-next's build and reviews (2026-11-23): nothing on the page tells that call from one she made for the reminder (Gemini's call carries no reply id; a time window would have no measured base). On OpenAI Realtime, realtime-cut-next (2026-11-25) ends a cut turn at the cancelled reply's `response.done`, so a call that arrives while her cut turn is still open is that turn's; a call that finds no open turn of hers (the first of the cut reply's events, or one after a silent card has ended her turn) is this shape. remind-first-next fixed the shape where the reminder cut her turn (a card from a cut turn passes nothing on). The one number-free fix, an urgent reminder passed on only by her words, would ask about her true card for it once more, on the common path.
- **Revisit when:** a traveller reports it; a real session's trace shows Gemini's order for a call a text input cuts; or the user says "hold an urgent reminder until Koe says it". OpenAI's protocol can tell such a call (it arrives while its cancel is outstanding); revisit with the OpenAI Realtime run.
- **Approved:** 2026-11-23, chief's decision C213 (not the user's words), Q-P option (1), with the README clause. Widened to OpenAI Realtime 2026-11-25, chief's decision C249 (not the user's words), Q-AF option (1); undo: "OpenAI's tool event says it came during a cancel".

### With live mode and GPS on, a reminder due just before annai came back gets no notification if annai is put away before it finds where you are
- **Kind:** known limitation.
- **What the traveller sees:** with live mode and GPS on, a reminder that came due in the half minute before annai came back on screen gets no notification if annai is put away or closed before it has found where they are (up to 15 s); it shows when that conversation next opens. As on main for the notification (the relay's copy was called off at the first look there too); better than main for the card, which main lost.
- **Why:** found by remind-first-next's re-reviews (2026-11-23, probed with the unit kit's push stand-in): annai calls the relay's copy off as soon as its catch-up finds the reminder, because it will say it itself; keeping the copy until annai has shown the card means moving the copy's send time in the push mirror (more parts for a glance shorter than 15 s), and not calling it off brings back a sounding notification over annai on screen (measured).
- **Revisit when:** a traveller reports a missed reminder after a short glance at annai; the push mirror is next reworked; or the user says "keep the relay's copy until annai has made the reminder" (moving the copy to the end of the wait doesn't do it: the design check of 2026-11-23 measured it).
- **Approved:** 2026-11-23, chief's decision C215 (not the user's words), Q-R option (1), with the README clause under Notifications.

### A reminder annai gives while it is out of view doesn't count as said, so its notification can come with sound, or stay beside its card
- **Kind:** known limitation.
- **What the traveller sees:** a reminder annai gives while it is out of view (its catch-up ended because annai was put away before it found where they are, annai started off screen, or a look while it runs hidden) doesn't count as said on screen (no one saw it). So a notification the phone held back for it (with no connection the relay's copy can't be called off) comes with sound instead of quietly, and annai doesn't close it: it stays beside the card, and if it arrives with annai back on screen it sounds over annai though the card is already in the chat. Nothing is lost; one reminder shows twice. And if the push mirror's cancel of the relay's copy fails while online, the relay sends it, annai doesn't close it, and the card the wake recorded shows again at the next open: two displays of one reminder (narrow; read from the code, not probed).
- **Why:** found by remind-first-next's reviews and said-mark-b's (2026-11-23, probed): counting a card no one saw as said would close the only notice that reached the traveller. The said-mark design check (2026-11-23) kept that rule: a reminder counts as said only when annai makes it with the page in view, its one write point (route B; remind-first-next's fix round 2 had added an offline mark, taken out). The open's owed reminders don't read the phone's shown notifications; joining them is a change to how the open settles a held reminder.
- **Revisit when:** a traveller reports a reminder shown twice after putting annai away, or a notification sounding over annai for a reminder already in the chat; or the user says "the open settles a copy the phone has shown" or "a card given out of view counts as said once its conversation is next on screen" (one field and about five lines: the fix the review named).
- **Approved:** 2026-11-23, chief's decision C216 (not the user's words), Q-S option (1), in this entry with the out-of-view rule it follows (the main session's call at remind-first-next). Widened to what route B leaves (an offline glance, annai started off screen, a look while hidden; the notification sounding over annai), chief's decision C223 (2026-11-23, not the user's words, Q-U option (1); to undo: "a card given out of view counts as said once its conversation is next on screen").

### A phone language annai doesn't list reads English Wikipedia only
- **Kind:** known limitation.
- **What the traveller sees:** with nothing chosen in Settings → Languages and a phone set to a language annai doesn't list (Estonian, say), the places tools and the offline pack read English Wikipedia only, as before this change, and English Wikivoyage only, as for a listed language with no Wikivoyage edition (Korean, say).
- **Why:** nothing gets worse than before; asking an edition for any phone language would cost a failed request per call where no such edition exists (the answer is a 95 KB page). Choosing the language in Settings → Languages, where annai lists it, reads that edition.
- **Revisit when:** annai's language list grows, or a traveller of such a language asks.
- **Approved:** 2026-11-19, chief's decision C129 (not the user's words), "Accept (Recommended)".

### A line given back while another conversation is open can be sent there
- **Kind:** known limitation.
- **What the traveller sees:** on a phone too full to write, a line typed for one conversation whose write is refused comes back into the one type box; if another conversation is open by then, the line sits in its box, and sent without a look it goes to that conversation.
- **Why:** annai has one type box for the whole app, the hand-back's design check's choice (2026-11-19): choosing where words go back by the conversation open at that moment needed the state four findings came from. Naming the conversation on the storage card would need it carried on the event, for a case that needs a full phone and an open of another conversation while the line was being written.
- **Revisit when:** a traveller reports a line sent to the wrong conversation.
- **Approved:** 2026-11-19, chief's decision C136 (not the user's words), accepted as recommended.

### On Android or a computer, the storage card at no byte free still suggests removing a trip
- **Kind:** known limitation.
- **What the traveller sees:** with no byte free at all, the storage card suggests removing a trip they no longer need and offers Go to Trips; Chromium then refuses the removal, and the card says "Nothing was removed." With a little room left, at the brim, the removal works and frees room.
- **Why:** the card can't tell the brim from no byte at all before a removal is tried, and in the common case, at the brim, the suggestion is right; the phone's own Settings come first on the card either way (the builder's probe in Chromium on Linux, 2026-11-19; not yet on a phone).
- **Revisit when:** a traveller reports a refused removal after the card suggested it.
- **Approved:** 2026-11-19, chief's decision C137 (not the user's words), accepted as recommended.

### annai can't be rolled back past a release that raises the database version
- **Kind:** known limitation.
- **What the traveller sees:** if a release that raises annai's database version is followed by a rollback to an earlier release, a phone that opened the newer one shows "annai couldn't start" until a newer release is out; a fix goes forward, never back.
- **Why:** IndexedDB refuses to open a database at a lower version than it holds (src/core/store-idb.js opens at an explicit version). Keeping a way for an older release to open a newer database would be a design of its own; the database's version has not changed since 2026-10-16.
- **Revisit when:** the first release that would raise the database version.
- **Approved:** 2026-11-19, chief's decision C145 (not the user's words), accepted as recommended.

### Two trips on home can share a colour
- **Kind:** known limitation.
- **What the traveller sees:** two trip cards on home can have the same colour, one time in ten for any two trips, except a copy of one (below); their names and dates still tell them apart. A copy of one trip imported again as a new trip has the same colour as the first, as it has its name and dates: its card takes that colour, lit by its dates and its own lines (a past one with no lines stays plain).
- **Why:** a trip's colour is one of ten hues, picked from when its record was made (src/ui/screens/trips.js `hueOf`), so it is the same at every draw, on every phone and after an export and import or a restore, with nothing stored. An import mints a new id but keeps the record's `created` (src/core/archive.js `importArchive`), so a copy imported as new is the same as the first in the one thing the colour reads. Ten are as many as stay told apart as soft washes in both themes; giving each trip a colour no other has would need a colour stored per trip, chosen against the others, and a trip would change colour when a restore or an import brought one that had it.
- **Revisit when:** a traveller finds two neighbouring trips hard to tell apart, or asks to choose a trip's colour.
- **Approved:** 2026-11-19, the user's answer "All recommended" to the trip-colour design's questions (its fourth: "Accept all three (Recommended)").

### A trip card can deepen while home is on screen
- **Kind:** known limitation.
- **What the traveller sees:** after a line reaches a trip while home is on screen (said or typed through the dock, or heard by live mode), the trip's card can step to its next strength at one of home's own redraws (a Next item's end, midnight, coming back to annai, a backup's end, a simulation starting or ending, a plugin's change to the UI it adds): its colour deepens where its strength changes (a happening card's only at its 80th line, an ahead card's at its 20th and 80th, a past card's at each step); nothing moves, as the card's size never changes with its colour.
- **Why:** how lit a card is is read at each draw of home, as everything else a card shows (its backup, its stamps); keeping each card's strength from home's first draw until the traveller leaves home would be state kept in the page, for a change of shade. A count crosses a step at most four times in a trip's life.
- **Revisit when:** a traveller notices a card change colour under their eyes and minds it.
- **Approved:** 2026-11-19, the user's answer "All recommended" to the trip-colour design's questions (its fourth: "Accept all three (Recommended)").

### A trip imported from someone else arrives lit by its use there
- **Kind:** known limitation.
- **What the traveller sees:** a trip imported from someone else's file that holds its history (a Backup of the trip, or a Share with History ticked) arrives on home lit by the lines its maker said in it, as if they were the traveller's own. A Share leaves the history out by default, so a shared trip arrives as one never talked in. Either way it keeps the colour of when it was first made.
- **Why:** how lit a card is counts the lines in the trip's log that count as said by the user (src/core/scopes.js `linesSaid`), and an imported history brings its lines as they were, as the user's own. An imported trip carries an `imported` mark (src/core/archive.js `importArchive`) and could count only the lines after it, but a traveller's own restored Backup of a trip carries the same mark, so counting only later lines would unlight their own restored trip; no line says whose it was.
- **Revisit when:** a traveller who imports shared trips finds an unused one looks used.
- **Approved:** 2026-11-19, the user's answer "All recommended" to the trip-colour design's questions (its fourth: "Accept all three (Recommended)").

### A removed trip's cost leaves the spending figures
- **Kind:** known limitation.
- **What the traveller sees:** after a trip or conversation is removed, Settings → Models → Spending's figures (All time, and the other ranges when its calls were in them) drop by what it cost, and so does today's spend that Spend per day counts, as before.
- **Why:** removing means removing (spec §4.9): the figures are summed from the trips' own logs, and keeping a removed trip's cost would need a ledger outside the trips, new stored state to keep right through every write, removal, import and restore.
- **Revisit when:** a traveller wants spend to outlive removals.
- **Approved:** 2026-11-19, the user's answer "All recommended" to the cost-display design's questions.

### After a long, heavy history, the spending figures take a moment
- **Kind:** known limitation.
- **What the traveller sees:** Settings → Models opens a moment later than before, and takes the same moment each time it is drawn again (after a change to a role's list), since it shows Spending's figures only once it has read them from every log (its other sections wait with it: nothing fills in later). In the cost-display design's measurements, made-up stores read in Docker on a desktop computer, not measured on a phone, which may be slower: about 0.3 s more in WebKit after a heavy year (19,300 log entries in 100 trips and conversations), about 2.3 s after a year at the heaviest day of real use every day (122,000 in 300); about 0.02 s after a month like the one measured.
- **Why:** nothing is stored for the figures: a running total would be state to keep right through every write, removal, import and restore, for the extreme case only. The whole read is only on Models; a turn's start (and again after a note cuts one of its steps short), and a live talk's start and each of its usage reports, read each log's newest 20 model calls and requests, then pages of 1000 for as long as the oldest one read is from today, and only with a Spend per day set.
- **Revisit when:** a traveller reports Settings → Models slow to open.
- **Approved:** 2026-11-19, the user's answer "All recommended" to the cost-display design's questions.

### Calls made before a model had prices stay "not counted"
- **Kind:** known limitation.
- **What the traveller sees:** Settings → Models → Spending's line "Not counted: # calls to models with no prices" keeps counting the calls a model answered before its prices were typed on its page, after they are typed; those calls stay out of the figures.
- **Why:** a call is priced when it is made (cost.js, a price may start on a date), and a price change must never rewrite past costs.
- **Revisit when:** the line misleads a traveller.
- **Approved:** 2026-11-19, the user's answer "All recommended" to the cost-display design's questions.

### A restored copy of a trip, with its history, counts its cost again
- **Kind:** known limitation.
- **What the traveller sees:** after opening their own Backup, made with its History, of a trip or conversation still on the phone (an active one asks "Replace mine" or "Add as a new one", or, in a backup of more than 3 conversations, one question for all of them: "Add as new ones" or "Replace mine"; an archived one comes back as a new copy without asking), Settings → Models → Spending's All time, every other figure the trip's calls were in, and today's spend that Spend per day counts rise by that trip's cost again, until the old or extra copy is removed. A Share carries no history unless its History box is ticked (that needs its places on), and a file without history adds no cost.
- **Why:** each way imports the file's history into a new trip, and "Replace mine" only archives the old one, whose cost still counts. Telling the two copies' entries apart would need an identity for log entries across copies, or a ledger outside the trips.
- **Revisit when:** a traveller restores trips they still have and the figures mislead.
- **Approved:** 2026-11-19, the user's answer in the main session's tab: "Accept (Rec.)".

### Only OpenRouter's voices stream, and Fish Audio's is the one that gains
- **Kind:** known limitation.
- **What the traveller sees:** apart from Gemini's own voice, only OpenRouter's voices can play while they are still being made, with the Stream switch on OpenRouter's Voice section (it starts off); Fish Audio's is the one that gains from it. HeyGen's and Gemini's through OpenRouter, which send only uncompressed audio anyway, stream too with it on. OpenAI's own voices, the local speech servers' and a custom address's have no Stream switch (unless it is already on there, typed in the JSON): each sentence arrives whole, in the smallest format the phone plays. Grok's, Voxtral's and Kokoro's voices through OpenRouter stay whole too, with the switch on. This narrows the user's ask of 2026-10-19, "Streamed voice for providers other than Gemini (play a clip while it is still being made)".
- **Why:** only OpenRouter's OpenAI-compatible voices were measured (the voice probe of 2026-11-19), and of them Fish Audio's gains most: it starts about 2 to 5 seconds sooner, where Grok's, Voxtral's and Kokoro's would start only 0.06 to 1.3 seconds sooner. OpenAI's own, the local servers' and a custom address's raw audio was never measured (whether their answer names the rate it is made at, as OpenRouter's does), and a stream that wasn't measured could fail every sentence of a voice.
- **Revisit when:** another voice is measured and gains from streaming.
- **Approved:** 2026-11-19, the user's answer in the main session's tab: "Accept (Rec.)".

### A stream that ends cleanly but early is heard short
- **Kind:** known limitation.
- **What the traveller sees:** with the Stream switch on, a voice whose connection closes early, without an error, has its sentence heard short: she plays what came and goes on to the next sentence. (A connection that drops with an error is a failed clip: the next voice says the whole sentence.)
- **Why:** raw audio carries no length, so a clean close early can't be told from the real end, and the clip's length from its words is only an estimate.
- **Revisit when:** a voice is seen ending a stream early with the switch on.
- **Approved:** 2026-11-19, the user's answer in the main session's tab: "Accept all three (Rec.)".

### On a slow link a streamed voice starts later
- **Kind:** known limitation.
- **What the traveller sees:** with the Stream switch on, when a voice arrives slower than it plays (on a link below about 0.7 Mbps, where Fish Audio's raw audio is 705.6 kbit/s, or from a voice that makes its audio slower than real time), she waits before she starts a sentence (the longer, the slower the delivery), then plays it without a gap, instead of stuttering. On a good connection she starts sooner, as the switch says.
- **Why:** a gap in the middle of a word is worse than a wait, so playback starts only when the rest will be in before it is reached (src/core/voice/stream-start.js); raw audio is about 5.5 times the data of the MP3 for the same clip.
- **Revisit when:** a traveller reports it; the switch can be turned off.
- **Approved:** 2026-11-19, the user's answer in the main session's tab: "Accept all three (Rec.)".

### A voice that answers a streamed ask with compressed audio fails that sentence
- **Kind:** known limitation.
- **What the traveller sees:** with the Stream switch on, a voice that doesn't send the raw audio annai asked for (an MP3 or a WAV, say, from a server that ignores the ask) fails that sentence: the next voice says it, and that voice rests for a few minutes.
- **Why:** the stream path takes only raw 16-bit audio at a rate its answer names; playing such an answer whole instead would need the stream contract to hand back a whole clip (a plugin API change), for a server that ignores the ask. The switch shows only where a provider's description names it, or where it is already on, and it starts off.
- **Revisit when:** a voice is seen answering a streamed ask this way in normal use.
- **Approved:** 2026-11-19, the user's answer in the main session's tab: "Accept all three (Rec.)".

### A rule picks when her conversation is summarized; she only marks where
- **Kind:** known limitation.
- **What the traveller sees:** Shiori doesn't choose when the older part of a conversation is summarized: a rule does. It is due at 100,000 tokens, or at the share of her model's window set in Settings → Models → Housekeeping when that is smaller; then, when they come back after her cache has run out (an hour less a minute for a model that lists an hour, unless Settings → Models → Cache says five minutes and the model lists five; five minutes less a minute for one that doesn't list an hour), the utility model writes the summary before her first answer. On the rare page left open, the timer runs her own model's summary just before the cache runs out, while it is warm; a timer that fires after it ran out (the page was asleep) does nothing, and the return does it. She only marks, with `mark_done`, where a summary may cut. Afterwards she remembers the earlier part as a summary and brings back its exact words with `recall`.
- **Why:** what costs is the return after a pause, which writes the whole conversation to the cache again; a rule sees that moment without her, and a summary there costs no cache. A tool that compacts at once would add a cache rewrite at every call, and a way for a page's text to talk her into it, for at most the warm reads' share of the cost (the self-compaction design, its option D).
- **Revisit when:** the trace shows her recalling often after summaries, or long warm spells over 100,000 tokens.
- **Approved:** chief's decision C138 (2026-11-19, not the user's words), accepted as recommended. Its words changed to what is built: chief's "the utility model writes it" holds at a cold return; on the warm timer's path (kept, C144) her own model writes it. Its words changed to what is built on 2026-11-26: the largest request's share went with the field (the user's U141).

### An open item she never wrote into the to-do list survives a summary only if the summary kept it
- **Kind:** known limitation.
- **What the traveller sees:** something asked, promised or waited for that Shiori never put in `/trip/todo.md` is in her context after a summary only if the summary mentioned it, or it is in the latest part, kept word for word. Its words are still in the log, and `recall` brings them back when she thinks to look.
- **Why:** the to-do list is the part no summary touches (it is in her now block at every request; a forced summary inside a Claude turn that runs warm also sends that turn's earlier now blocks, each with the list as its step sent it); whatever else is open in the older part is summarized with the rest of it, and what is open in the latest part stays word for word. Her instructions and the list's own label tell her to keep every such item there.
- **Revisit when:** a real-model check or the trace shows open items lost at a summary that were never on the list.
- **Approved:** chief's decision C139 (2026-11-19, not the user's words), accepted as recommended. Its words changed: "the summary" for chief's "the utility model", since on the warm timer's path her own model writes it, and "or it is in the latest part, kept word for word".

### Koe doesn't see the to-do list
- **Kind:** known limitation.
- **What the traveller sees:** while Shiori is two halves, Koe, her quick voice, has no to-do list in its context in either of its modes, chat or live: asked what is still open, it answers from what it has or asks Kokoro, who has the list. It could read `/trip/todo.md` with its read tool, as any file, but isn't told of it.
- **Why:** Koe's context is small for speed (spec §6.3), and its now block carries no plan line either; Kokoro holds the list and works on it. Koe's chat and live modes share one now block.
- **Revisit when:** a drive or the trace shows Koe answering wrongly about what is still open.
- **Approved:** chief's decision C148 (2026-11-19, not the user's words): Koe has no list in either mode (C140 widened from its live voice to both modes).

### A conversation never paused for her cache's life grows until a request would overflow
- **Kind:** known limitation.
- **What the traveller sees:** a conversation that never pauses long enough for her cache to run out is not summarized at 100,000 tokens: each return reads the cached conversation, at the cached price. It grows until a request would overflow (over 90% of her model's window), where it is summarized inside the turn before her next call; with no window on her model's page, until her provider refuses a request as too long, where it is summarized and the request sent again (a window typed on the model's page usually saves those refused sends, one for each main model). Each request sends the whole conversation again: about 1 MB at 300,000 tokens, up to about 3.3 MB at 90% of a million-token window. Each call costs more as it grows (Claude Opus 5.5: about $0.06 a call at 300,000 tokens).
- **Why:** while the cache is warm a summary rewrites the cache, which pays back only after about 13 more warm calls (the design's reading of 26 days of real use, the 236 Opus calls; the median spell between pauses had 5 calls); at a return after a pause the rewrite costs nothing extra. No spell like this is in the trace.
- **Revisit when:** the trace shows long warm spells over 100,000 tokens.
- **Approved:** chief's decision C146 (2026-11-19, not the user's words): C141 corrected, a conversation with no pause grows to 90% of the window or the largest request, where housekeeping is forced, not to the old 70% threshold. Its words changed to what is built on 2026-11-26: the largest request went (the user's U141), and with no window listed the provider's refusal is where it stops.

### After a cold return over 100,000 tokens, her first answer waits for the summary
- **Kind:** known limitation.
- **What the traveller sees:** the dock says "Working on tidying up the conversation", then the conversation shows "Earlier conversation summarized", and her first answer comes after the utility model has written the summary. On the real-model check (2026-11-19: Step, a local model and Gemini 3.5 Flash Lite as both main and utility model) the summary took 1 to 20 s and her first answer came 5 to 53 s after the line was typed (median 17 s, 16 runs; the local model's waits followed a restart turn the reload caused in 7 of its 10 runs), with the largest request about 12,000 to 28,000 tokens, not 100,000. The one long run, Step's (seeded to 115 exchanges), sent a request of 96,501 tokens by Step's own count and summarized 61,646 tokens in 14.7 s; its first answer was not measured, so expect longer at 100,000 and more. Koe, while Shiori is two halves, answers at once as before.
- **Why:** without it, that first answer would write the whole conversation to the cache at full price; answering first and summarizing after would pay that write and the summary both.
- **Revisit when:** travellers find the wait too long, or the utility model in use is much slower.
- **Approved:** chief's decision C142 (2026-11-19, not the user's words), accepted as recommended. Its words changed: chief's "about 20 s" is replaced by the wait measured, at about 12,000 to 28,000 tokens, the 16 timed runs; no Claude model was run (the user, 2026-11-19: "if it works on less capable models it should work on more capable ones").

### A reply that took several attempts can bring one summary early; one that searched, one late
- **Kind:** known limitation.
- **What the traveller sees:** after a reload, or with another conversation opened in between, housekeeping reads the last call's count from the conversation's log, which keeps one count per reply, the sum of its attempts: a reply whose first attempt failed after spending tokens, or that another model finished, counts each attempt's prompt, up to about twice the real one, so a conversation from about 50,000 tokens can be summarized at its next cold return. A reply in which the provider ran its own web search gives no count at all (its count sums the steps inside it, up to 2.1 times the prompt in the trace); the request's own estimate stands, which reads about 0.7 of Opus's own count, so a conversation of up to about 140,000 tokens whose last reply searched can be sent whole at a cold return, one summary late.
- **Why:** a field for the answering call's own count would be one more stored field for a rare case (the spec check's 3.7: no new field). One summary early loses nothing the to-do list and the kept third hold; one late costs one return at full price.
- **Revisit when:** the trace shows summaries well under 100,000 tokens, or cold returns over 100,000 sent whole.
- **Approved:** chief's decision C147 (2026-11-19, not the user's words): C143 corrected, a searched reply gives no count, so one late; several attempts after a reload or a switch, one early.

### A summary forced in the middle of a turn can carry the to-do list as it stood at that turn's earlier steps
- **Kind:** known limitation.
- **What the traveller sees:** nothing directly. On Claude, when a request would overflow in the middle of a turn that runs warm, the summary her own model writes sees the turn's earlier now blocks, each with the to-do list as its step sent it, so the summary may mention an item she has since closed. The list itself stays true in todo.md, and her next request carries it as it is.
- **Why:** those kept blocks are what lets the warm summary read the cache instead of writing it again; leaving them out would cost a full write of the conversation each time.
- **Revisit when:** a trace shows her acting on a closed item after a summary.
- **Approved:** chief's decision C150 (2026-11-19, not the user's words), accepted as recommended.

### A file moved between trips during a Backup of everything can be missing from it
- **Kind:** deferred.
- **What the traveller sees:** rarely: a file moved from one trip to another (or to the files waiting with Shiori) in the moment a Backup of everything is being made can be in neither trip's part of that Backup; the file itself is fine on the phone, and the next Backup has it.
- **Why:** each trip is listed in its own transaction (src/core/archive.js), so a move between two listings can fall between them; one moment across every trip would need the whole phone's files read at once, or a restart rule that a busy conversation might never let finish. Found by pack-history-next's second re-review (2026-11-20), on main before it.
- **Revisit when:** the next version's Backup work: a move counted as a change of the Backup's listing (a restart, as a freed content already is), or a design that lists every scope together.

### Offline, the pack holds each edition's nearest 20 Wikipedia articles at each stop and every 15 km of the way
- **Kind:** known limitation.
- **What the user sees:** offline, and online inside the pack's circles, `nearby`'s articles are the pack's: each edition's nearest 20 at each stop and every 15 km of the way, with every listed edition's summary of each of them, fewer than online (Takayama: 59 within 1 km online, about 37 within 10 km in the pack). The answer says the pack holds only the articles near its stops and Wikipedia may have more.
- **Why:** a part is one request of 20 summaries (the extracts API's own limit), and a whole trip is many parts; the second stage then brings every listed edition's summary of each held article (24 of 38 at Tokyo Station in Japanese and English, against 2 without it).
- **Revisit when:** a traveller misses an article offline.
- **Approved:** chief's decision C162 (2026-11-20, not the user's words), accepted as written.

### From the offline pack, `nearby` doesn't say that Wikipedia's part of a download failed
- **Kind:** known limitation.
- **What the user sees:** where a place's Wikipedia lists came in no edition (Wikimedia down or blocked for the whole download while OpenStreetMap answered, or one part's lists failing in every edition), `nearby` from the pack, online inside its circles too, lists the articles the pack holds there, maybe none, and says the pack holds only the articles near its stops and Wikipedia may have more: it never says Wikipedia has nothing there. It doesn't say a download failed, or name the language the pack lacks. The pack panel says how many parts didn't download and offers Try again or Download the rest.
- **Why:** the files the pack holds can't tell a part that never came from a place with no articles; knowing needs the plan, which changes on the road with no download, or a new record in the manifest. Three review rounds each found a fault in a rule that guessed it (the design check of 2026-11-20).
- **Revisit when:** a traveller is told there is nothing on Wikipedia at a stop whose lists failed, or the manifest gains a record of the parts a download asked for.
- **Approved:** chief's decision C164 (2026-11-20, not the user's words), accepted as written, with the condition that the answer never claims Wikipedia has nothing there.

### A city stop's OpenStreetMap part may not finish within the pack's 60 s
- **Kind:** deferred.
- **What the traveller sees:** in a big city, the offline pack may hold no places for the stop itself: its part (every kind of place within 5 km) can take Overpass longer than the query's own 60 s, so it fails, and `nearby` there asks Overpass online, which takes about 35 s.
- **Why:** not measured: the editions design's counts at Tokyo Station took 82.5 s for 1 km, and its 5 km batches timed out at 65 and 72 s (2026-11-20); a town (Takayama, 5 km) answered in 53.5 s. The query is as it was before the pack's caps went.
- **Revisit when:** the next build on the pack: run the pack's own query at a city centre and a built-up corridor, then a smaller radius or a split by kind, from the measurement.

### Microsoft's MAI voices start with a Czech voice
- **Kind:** deferred.
- **What the traveller sees:** a Microsoft MAI voice added from OpenRouter's list (or by id) starts with the list's first voice, a Czech one (`cs-CZ-Grant`), for sentences in the traveller's own languages; setting its Voice fixes it.
- **Why:** the list's rule takes the first warm or neutral voice, else the first, and MAI's voices are named by locale, none of them warm or neutral by name. Found by voice-id-next's final review (2026-11-20).
- **Revisit when:** the next build on OpenRouter's voices: a voice named by a locale picked by the traveller's first language.

### A refused voice sample is asked again in other formats, the same request for a voice that only sends uncompressed audio
- **Kind:** deferred.
- **What the traveller sees:** nothing on screen; a refused sample or sentence of a HeyGen or Gemini voice through OpenRouter makes three identical requests (the format retry asks MP3 then WAV, and both are asked as uncompressed audio for these voices) before the next voice speaks.
- **Why:** the retry (src/core/voice/voice.js `#clip`) retries any 400 in other formats; it was written before voices that take one format. Found by voice-id-next's unit review (2026-11-20); it spends requests, not correctness.
- **Revisit when:** the next build on voices: retry only a refusal about the format, or not at all for a voice that asks one format.

### The pack treats Wikimedia's "too many requests" as the site being down
- **Kind:** deferred.
- **What the traveller sees:** rarely: if Wikipedia or Wikivoyage answers the pack's download with 429, the parts it was fetching are counted as failed and wait for the next download, instead of the download waiting and going on.
- **Why:** the pack asks once a second, far under Wikimedia's published 200 a minute, so a 429 needs something else on the same address; the design found it (2026-11-20) and left it out of the editions builds.
- **Revisit when:** a trace shows a 429 from Wikimedia during a download: wait its `Retry-After` (or five seconds, Wikimedia's rule) once, as the OpenStreetMap side already does.

### An address annai's own tools didn't write can link to another page or none
- **Kind:** known limitation.
- **What the traveller sees:** an article address Shiori writes herself, a web search's row, fetch's Source line, an OpenStreetMap or Nominatim website, or a card or recap written before 2026-11-20 can link short or wrong in chat: cut at a last `.,;:!?'"`, at one of the Japanese and Chinese marks that end an address (`。、，；！？（）」』”`, as in a raw `…/中国（上海）自由贸易试验区`), or at a second level of brackets (`Foo_(a_(b))`). Addresses from annai's places tools link whole.
- **Why:** the renderer can't tell a title's last stop from a sentence's; only the writer can encode it, and annai's tools do (`pageUrl`, src/core/wiki.js).
- **Revisit when:** a traveller meets a wrong link, or a trace shows her writing article addresses no tool gave; the route that removes it is asking her for `[title](address)`, which needs a real-model check.
- **Approved:** chief's decision C151 (2026-11-20, not the user's words), accepted as recommended.

### Text right after an address with no space can be taken into its link
- **Kind:** known limitation.
- **What the traveller sees:** a Japanese or Chinese letter (`…/清水寺をご覧ください`), a mark outside the set that ends an address (`・ ー ： 【 「 〜 … 》 〉 〕 » ’`), or an ASCII `(…)` note (`…/清水寺(英語版)`) written right after an address is linked with it. Where annai shows Kokoro's words, or a reminder Shiori set, as plain words (the card at the top and the voice since answer-words-next, 2026-11-24; for her reminders also the phone's notification, the wake line and a watch's error line since watch-words-next, 2026-11-25), the address reads as its site and those words follow it, so they are still shown and said.
- **Why:** no rule can split a raw title from the text after it; titles are written raw on purpose (a model reads one %XX as several tokens).
- **Revisit when:** as the entry above.
- **Approved:** chief's decision C152 (2026-11-20, not the user's words), accepted as recommended. Widened to Shiori's own reminders where nothing is drawn, chief's decision C237 (2026-11-25, not the user's words, Q-Y option (1); undo: "show her reminders as written").

### An OpenRouter voice its list gives no voice for starts with Women KatKat
- **Kind:** known limitation.
- **What the traveller sees:** a voice model added by id while annai can't read OpenRouter's list (offline, slow or refused), with an id the list lacks, one the list names no voice for (ByteDance's), or one added by id before 2026-11-20, starts with Women KatKat, a Fish Audio voice, which the other makers tried refuse: HeyGen, Kokoro and ByteDance's say why; Grok's and Voxtral's answer a bare 404, and Play a sample then says the provider doesn't know the model, address or voice. Removing it and adding it again online, or setting its Voice, fixes it; ByteDance's takes none (`"voice": null` in Extra request fields).
- **Why:** a voice needs one its server knows, which only the list says; a table of voices per maker would go stale.
- **Revisit when:** travellers add voices offline, or OpenRouter's list says which voice a model starts with.
- **Approved:** chief's decision C153 (2026-11-20, not the user's words), accepted as recommended.

### A past trip whose pack is never downloaded again keeps its older pack copies
- **Kind:** known limitation.
- **What the traveller sees:** nothing on screen. Since 2026-11-20 each download of a trip's offline pack forgets the pack's older versions; a past trip whose pack is never downloaded again keeps the copies it already held (since the pack shipped, 2026-10-16) until the trip is removed, on the phone and in Backups of everything.
- **Why:** they go at that trip's next download (a refresh after a month, a plan change, or Download); a sweep at every start, or each time a trip opens, would read each trip's file history for a one-off amount.
- **Revisit when:** a phone runs short with past trips kept, or Settings shows annai far larger than its trips.
- **Approved:** chief's decision C155 (2026-11-20, not the user's words), accepted as recommended.

### A tab another tab took over keeps what it had already started
- **Kind:** known limitation.
- **What the traveller sees:** after "annai was opened in another tab", the stopped tab keeps its timers and listeners (and GPS only in a narrow window during start-up) until it is closed; nothing writes, since its store is closed. On main before 2026-11-20 too, after any takeover.
- **Why:** stopping all of it means reordering start-up (the agent's open, Live and push depend on each other's order), for a tab that usually sits in the background, where the phone pauses it.
- **Since remind-log-next (2026-11-22), also:** with two tabs of annai open at once (a desktop's tabs or windows, an iPad's split view), the tab that was taken over can still say a reminder that fires there while the new tab says the same one, and a line Koe was finishing at the takeover can show again in the new tab: a reminder heard twice, never lost. The takeover silences that tab's turn (`leaving()`) and closes its live session (`hush('away')`); its other paths stay, as the rest of this entry says.
- **Revisit when:** battery or GPS use is reported from a stopped tab, or start-up's order changes; or a reminder heard twice from a stopped tab is reported; or the user says "reload the old tab".
- **Approved:** chief's decision C156 (2026-11-20, not the user's words), accepted as recommended. The remind-log-next clause: chief's decision C187 (2026-11-22, not the user's words; to undo: "reload the old tab").

### A Backup or Share during which two changes land fails with Try again
- **Kind:** known limitation.
- **What the traveller sees:** a Backup or Share during which two changes land (two pack downloads ending, or one ending and a file deleted for good or a trip removed, within one export) fails with "Something on this device changed while exporting, so nothing was exported. Try again."; automatic backups try again by themselves after 15 minutes, without lengthening their wait.
- **Why:** an export reads a trip one moment at a time and starts again once when a change frees what it listed; one fresh start covers one change, and an unbounded retry could hang an export behind a fault.
- **Revisit when:** a traveller meets it.
- **Approved:** chief's decision C157 (2026-11-20, not the user's words), accepted as recommended.

### A guide only the traveller's edition has is not in the offline pack
- **Kind:** deferred (was a known limitation, chief's decision C154; the user's answer to U111 made it planned work, 2026-11-20).
- **What the traveller sees:** offline, `guide` has nothing for a place English Wikivoyage has no guide for, though the traveller's own edition has one; online it is read under that edition's own title. In a small sample (the first page of Japanese Wikivoyage's list, 2026-11-20, biased toward its early titles) 11 of 21 pages had no English twin, most of them towns, so this is not a rare case for a Japanese reader. Where English has a guide by the name asked, another edition's guide comes only where English's page links to it.
- **Why:** English decides which place a name means, so the same question brings the same place in every language and with or without the pack (the design check of the editions build: storing an edition's own guides let one edition's meaning of a name sit beside or replace English's, as "Kashmir", "Granada" and 「台湾」 did); a guide with no English twin has no second edition to set beside it.
- **Revisit when:** planned for the next version, after the editions build's part B is released and the fixes from the user's own phone checks (chief's order of work, 2026-11-20): store in the pack the guides only the traveller's edition has, keeping English's rule for which place a name means (the starting point: the by-name design check's section 2, its route that keeps them, with the gap it names for readers of two editions other than English). Its row is in docs/progress.md.
- **Decided:** the user, 2026-11-20 (U111, in chief's tab): "for annai, the offline pack, maybe put as deferred to store non english pages as well? because might be helpful? as you also mentioned this is maybe not a rare case?"; before it, chief's decision C154 (2026-11-20) had accepted it as a known limitation, its reason corrected to the sample.

### A stopped offline-pack download goes on by itself an hour later
- **Kind:** known limitation.
- **What the traveller sees:** on Wi-Fi, after a download stops, annai waits an hour before going on by itself, whatever stopped it: their own Stop (so on a phone tethered to a hotspot, which says Wi-Fi, a Stop holds an hour, not until they tap Download); leaving Wi-Fi for a moment during annai's own update, or opening another conversation during a download (back, nothing happens for up to an hour; "Download the rest" goes on at once); a change to the itinerary or the languages inside that hour waits for its end (the panel says "The itinerary changed since" with Update).
- **Why:** the pack's manifest says that a run was stopped and when, not who stopped it; telling them apart needs a stored field or a mark a relaunch loses, and three fix rounds found holes in that state. One rule needs none and holds across a relaunch (the keeper's design check, 2026-11-20).
- **Revisit when:** a traveller reports a pack left incomplete after a Wi-Fi drop or a look at another conversation, or a download restarting on a hotspot.
- **Approved:** chief's decision C159 (2026-11-20, not the user's words), accepted as written; the user may say "my Stop holds until I tap Download".

### On a slow link, web search's fallback keeps fewer guides with several languages
- **Kind:** known limitation.
- **What the traveller sees:** when the free search providers fail and annai's own fallback answers, on a connection where a request takes 2.5 s or more and four or more Wikivoyage editions are read, the later editions' guides are left out (English's stays).
- **Why:** the fallback has 9 s in all (the chain's reserve), Wikimedia's rule allows 3 requests at once, and each edition's guide is one more request.
- **Revisit when:** a slow-link report, or measured request times from a phone.
- **Approved:** chief's decision C160 (2026-11-20, not the user's words), accepted as written.

### A message with several photos carries them all for its turn and the next
- **Kind:** known limitation.
- **What the traveller sees:** photos sent together in one message all go in each request of Shiori's turn about them and of the next one, both halves: four at the default (256 KiB each, about 1.4 MB as sent) make requests the size that broke off on a car's mobile data (2026-11-21), so on a weak connection such a message can fail where one or two photos go through. Older photos are not sent again after that (photo-budget-next).
- **Why:** what the traveller just sent is what they ask about; stubbing some of it would hide part of the question, and a cap per message would refuse what they chose to send. Each photo is already small.
- **Revisit when:** the trace shows messages of several photos failing on slow links; or the user says "cap the photos per message" or "send only the newest".
- **Approved:** 2026-11-21, chief's decision C177 (not the user's words), with a README line saying what the traveller can do.

### A plugin trigger's firing text, fallback and place aren't blanked
- **Kind:** known limitation.
- **What the traveller sees:** nothing on screen. A third-party plugin that registers a trigger type and puts its service's answer, key included, into a firing's text, fallback or place would put the key in the conversation's log and Shiori's wake line (src/core/live/live.js `#fire`, `#reason`). Its error words are blanked (`#noteOnce`), as is everything a plugin hands annai through its API (plugin-words-next).
- **Why:** a trigger's `check()` is synchronous, so blanking its words needs a place of its own in live.js, the per-channel route plugin-words-next's step back avoided; no plugin registers a trigger and docs/plugins.md doesn't offer them. Under the user's "redaction for accidental leaks only, with simple rules" (2026-11-13).
- **Revisit when:** docs/plugins.md documents triggers, or a plugin registers one; or the user says "blank the trigger text too".
- **Approved:** 2026-11-22, chief's decision C197 (not the user's words).

### A file a plugin writes, and a plugin's blobs, are kept as written
- **Kind:** known limitation.
- **What the traveller sees:** nothing on screen. A plugin that caches its service's raw answer, its key in an address, in a trip file (`annai.files`) or as a blob kept with a log entry (`events.append`) leaves the key there: the files tool reads the file as it is, and backups carry both.
- **Why:** a file stays as written: its bytes, its schema, undo and the plugin's own read-back depend on it, and blanking on write would change files a plugin writes on purpose. docs/plugins.md tells authors never to put keys in files. Under "redaction for accidental leaks only, with simple rules" (2026-11-13).
- **Revisit when:** a plugin is seen writing a key into a file or blob; or the user says "blank what a plugin writes".
- **Approved:** 2026-11-22, chief's decision C198 (not the user's words), with a line in docs/plugins.md.

### A credential annai doesn't keep, shaped unlike a key, isn't blanked by its shape
- **Kind:** known limitation.
- **What the traveller sees:** nothing on screen. annai blanks every key it keeps wherever it shows; a credential it doesn't keep is blanked only by its shape, and since plugin-words-next the Basic and Bearer shapes are narrow: a Basic value only as base64 of UTF-8 `user:pass`, a Bearer value only with a digit or as a JWT. A Bearer token of letters only (about 3% of 20-character random tokens), or a Latin-1 or colon-less Basic value, echoed in a provider's error or a plugin's answer, stays in the trace and in what Shiori reads.
- **Why:** the shapes now run over ordinary answers (an installed plugin's text, search rows), where the wider rule garbled travel words ("Delta Basic Economy/Main Cabin" became "Basic «key» Cabin" in the official search plugins' rows; "Bearer instruments" became «key»). The shapes exist for credentials annai doesn't keep; a second rule, wide for errors and narrow for answers, adds a part.
- **Revisit when:** an unknown credential is seen unblanked in a trace or log; or the user says "the wider shapes for error words".
- **Approved:** 2026-11-22, chief's decision C199 (not the user's words).

### PDFs sent with a refused one go as words until the next summary or Start fresh
- **Kind:** known limitation.
- **What the traveller sees:** when every model a request went to refuses it while it holds several PDFs, and the request with them as words is answered, every PDF of that request goes as words in that half of the conversation, a fine one beside the refused one too, until the conversation is next summarized or started fresh; one card names them all. After that she can read them one at a time.
- **Why:** the providers' words don't name which PDF they refused, so annai can't tell them apart without one more send per PDF on the link that just refused; one refused file among several is rare; the mark ends at the next summary (pdf-refused-next).
- **Revisit when:** a traveller is seen losing a fine PDF this way; or the user says "test each PDF on its own".
- **Approved:** 2026-11-22, chief's decision C200 (not the user's words), with the README's line.

### A PDF this half marked once before a summary skips the summary the next time every model refuses it as too long
- **Kind:** known limitation.
- **What the traveller sees:** a PDF Shiori's half marked as refused (whatever the reason) before a summary or Start fresh, back whole later in a request that every model asked refuses as too long and whose PDFs that half all marked before, is sent as words at once, with no summary first: where a summary would have made room (a PDF marked for another reason, beside a refused one, while a model rested or by a passing refusal; or one too long then that would fit after a summary that keeps less), she answers without it, a second card says the models refused a request with it, and it goes as words until the next summary (reading it then works). And a PDF too long for every model's window still goes whole once to each model after each summary before it is marked again (it went twice, with one more summary, before pdf-again-next); beside a PDF that half hasn't marked before, the summary comes first and it costs that round again.
- **Why:** pdf-again-next (chief's decision C203) tests such a request at once so a PDF that never fits isn't sent again and again after each summary on a slow link (the user's words of 2026-10-19: "we are an agent on the go possibly with spotty internet. thus we shall make these optimizations when possible."); the shapes that lose are rare (a conversation within one PDF of the window: for the trace's largest PDF, about 174,000 to 180,000 tokens of 200,000) and recoverable with a card; a fit check against what a summary would keep needs the summary's cut in the step loop, more code; every round's findings on that work landed in the mark.
- **Revisit when:** a traveller is seen losing a PDF a summary would have kept; or the user says "narrow the skip to too-long marks", "take the skip out" or "check the fit first".
- **Approved:** 2026-11-23, chief's decision C209 (not the user's words), Q-M option (1), with the README's line. U116 stays the user's.

### A model that was resting and not asked gets a refused PDF's words too
- **Kind:** known limitation.
- **What the traveller sees:** when the models asked all refuse a request holding a PDF, and one model was resting and so not asked (Koe never asks a resting model; Kokoro asks one resting model at most), the PDF is marked for that half, and the resting model, awake again, gets the words though it might have read the PDF, until the next summary or Start fresh.
- **Why:** making a resting model block the test would bring the original failure back (every turn failing) while a model stays rested for a key or credit problem; the mark ends at the next summary (pdf-refused-next; a test pins the choice).
- **Revisit when:** the trace shows a PDF lost this way; or the user says "ask the resting model first".
- **Approved:** 2026-11-22, chief's decision C201 (not the user's words), with the README's line.

### A refusal that wouldn't happen again can mark a PDF
- **Kind:** known limitation.
- **What the traveller sees:** a provider's passing refusal (a 400 that goes away on the next send) of a request that holds a PDF, when the request with the PDF as words is then answered, marks the PDF: it goes as words, with the card, until the next summary or Start fresh, though it was fine.
- **Why:** the test (the same request with its PDFs as words) can't tell a passing failure from the PDF; telling them apart would take one more whole send of the PDF on the link that just failed; the mark ends at the next summary (pdf-refused-next).
- **Revisit when:** the trace shows a fine PDF marked this way; or the user says "retry the PDF before marking it".
- **Approved:** 2026-11-22, chief's decision C202 (not the user's words), with the README's line.

### A model with nothing else in its list that never answers a request with a photo, a file or a recording is asked again every time
- **Kind:** known limitation.
- **What the traveller sees:** a model cut before its headers rests only once another model answered in its place, and a transcription model that can't be reached only once another transcription model heard the line in that call (so a 20 s dip no longer takes voice away for 3 minutes). With nothing else answering: one transcription model whose server hangs makes each heard line wait about 20 s before her turn (with a quick-decision model) and about 24 s in it; one that can't be reached at all (its server down, a wrong address, a self-hosted server whose tunnel is off) or that refuses every recording is asked again for each heard line, and fails it at once when its address refuses or doesn't resolve (a host that never answers waits out its send time, as a hang does). When "Send audio to the model" is in the speech-in list and a main model takes audio, that model is sent the recording and answers the line when it can. Without such a model, without that entry in the list, or while that model fails, Shiori answers the heard line in its own turn as one she couldn't hear: she is sent "[audio, not transcribed]", and a line typed after it is answered as usual (with Koe and Kokoro a typed line can still fail, in the shapes below), the heard line still read to her as not transcribed. Each such turn costs a model request (the recording goes up over the phone's link) and, with voice on, her spoken answer; a model that refuses recordings is sent each unwritten line once per step of the turn and once more when it is written down (a compressed clip a chat model refuses on format is sent once more as WAV in the same call, and that model is sent WAV alone until the page reloads; a transcription model that refuses both formats is sent both each time). The card "Nothing in the speech-in list worked for …" no longer shows for a heard line its turn answers, so nothing on screen points at Settings → Models for a transcription model that fails without resting. For a hang she stays busy, after her answer, about as long again for each line not yet written down. With Koe and Kokoro, when Kokoro has no ear (no main model of hers takes audio, or "Send audio to the model" is not in the speech-in list), Koe answers, and the turns that count below are Koe's while she is on a text model (a turn for Kokoro's note included; none while she is live), Kokoro's when Koe is down. When "Send audio to the model" is in the list and a main model of Kokoro's takes audio, Koe's call fails quietly (Koe then rests a minute) and Kokoro's call answers such a line, from the sound when her model hears it, as not transcribed when another of her models answers; when her call fails too, the card "Shiori can't reach her model" shows for both halves, once (it needs both halves' calls failed since each last worked; here Koe's failure on that line comes first), and Koe then answers the lines after her rest, the heard line read to her as not transcribed, until a turn of Kokoro's works (lines typed while Koe rests are Kokoro's). After a turn's call of Kokoro's failed, and until a turn of hers works, Koe answers such a line herself, first, as one she couldn't hear: she answers before Kokoro's call for the line runs, so this is a guess from how Kokoro's last turn's call ended, which her next turn that works corrects. Kokoro's model may then answer the line from the sound; a failing call of Kokoro's shows her own card instead, or Koe says in plain words that she couldn't check, when she asked Kokoro or waits for her; and each line said before that turn ends gets Koe's not-heard answer, so with three of them the first is given up unwritten at Koe's third turn that worked. A heard line nothing wrote down by the end of three turns that worked of one half (each half keeps its own count), its own among them, is stored as "[audio, not transcribed]" and its sound let go (the entry "A heard line nothing could write down is given up after three turns that worked" has the rest). Phone dictation listed after it no longer takes over as it did for 3 minutes before; one reader model that hangs makes each photo wait 70 s (110 s while Koe works) and come back undescribed. A model rested after a cut send once another answered is also passed over as a reader and by Koe for those 3 minutes. What the traveller can do: move Phone dictation above the model in Settings → Models, or switch the model off.
- **Why:** a browser can't tell a dead server from a dead link before something else answers, and resting on a dip took voice away after every dead spot, the user's stated condition ("we are an agent on the go possibly with spotty internet", 2026-10-19); the user's own transcription model is a cloud one (the trace, 2026-11-23: 19 of 19 answered). The heard-line part is so since clip-route-next with route (d) (2026-11-26; a real model, gemini-3.5-flash-lite, answered such a line "Could you say that again?" and slept); earlier builds failed the heard line's own turn with the card, and before that every later line too. The rests and the take-over change came with cut-send-next, and for a hang it shipped 2026-11-20.
- **Revisit when:** a traveller reports every heard line failing while a server is down; the user's list gains a transcription model that can be down for long before dictation; or the user says "dictation takes over from a model that can't be reached".
- **Approved:** 2026-11-23, chief's decision C212 (not the user's words), Q-O option (1), with the README's line; its Koe-and-Kokoro sentences changed to route (d) 2026-11-26, chief's decision C259 (not the user's words), Q-AP option (a); to undo: "record that Kokoro's last call answered only through the last pass".

### Stars and links Shiori writes that annai can't read as she meant stay as written
- **Kind:** known limitation.
- **What the user sees:** annai's own Markdown reader (src/core/markdown.js) draws her cards and lines and gives the answer card and the voice their words, and, since watch-words-next (2026-11-25), a reminder she set where nothing is drawn: the card at the top, the voice, the phone's notification, the wake line and a watch's error line. It guarantees that a star straight before a digit or `#` (a gate code's, `*1234#`, `*100*1#`, in English, Japanese or Chinese) is never taken, and that a phone or mail link reads with its number or address (`call the hotel (+81 …)`). What is left, each rare: in text without spaces an emphasis can start or end at another star: an italic that starts or ends at a digit shows its stars (`*3 nights*`, `*大人*1000円`) and its closing star can pair with the next one on the line (`*5分*後に*重要*です` puts the italic on 後に; rarely a star inside an exact string later on that line, a password after `*5G*,`, is lost); a bold glued to an italic (`**注意***重要*`); a star after a code's digits (`1234*`) or a letter-led code (`*A1#`) can still pair. Tables, `>` quotes, `---` rules, an italic holding bold and an image's `!` show as written. Links: a titled link in parentheses (`[a](https://… (title))`) links a wrong page; a link with no scheme, in `<…>` or to a path reads by its name only; words in parentheses with no space right after a bracket read as a link's address and are dropped (`[A出口](徒歩5分)`); prose after a web address inside a link's parentheses joins the address (`[a](https://x.test/a see b)` links a wrong page and drops "see b"); an italic around a bare address leaves its star in the address; a phone or mail link is words, not a tap. Where nothing is drawn, an exact string with paired stars outside backticks in her reminder reads without them (`Wi-Fi password: ab*cd*ef` reads `abcdef` on the card, in the voice and in the notification; in backticks it stays whole). A wake line ("Shiori woke for a reminder…") written before watch-words-next's update keeps her Markdown as written: the stored wake can't tell her title from a plan item's; new ones are plain.
- **Why:** found by star-codes-next's reviews (2026-11-25): a differential fuzz of 1.2 million lines against the reader before it lost no star before a digit or `#` and read 94% of lines as meant (40% before); every fix tried for what is left moved a stray star rather than removing it (the second re-review's step back), and CommonMark's delimiter pass (about a hundred lines) would still need the digit rule.
- **Revisit when:** the user meets one, or the trace shows these shapes in her real lines (count them when the trace is next read for another reason; no separate run); the fixes then: CommonMark's delimiter pass with the digit rule, or a web address that ends at a space (as before star-codes-next), or tap-to-call for phone and mail links (needs an iPhone check).
- **Approved:** 2026-11-25, chief's decision C236 (Q-X option (1)); undo: "build the CommonMark pass", or "a web address ends at a space". Widened to Shiori's own reminders where nothing is drawn, with the clause on wake lines written before that update, chief's decision C237 (2026-11-25, not the user's words, Q-Y option (1); undo: "show her reminders as written" for the widening, "read old wake lines plain too" for the clause).

### A reader whose record lacks a limit its provider enforces refuses the first photo it is sent, or every one in two cases
- **Kind:** known limitation.
- **What the traveller sees:** not the user's setup (Claude sees photos and reads PDFs itself; an iPhone makes JPEG). When the main model sees no photos (or reads no PDFs) and a reader role's model reads for it, a reader whose record doesn't state a limit its server has (a model added by hand has none; Gemini's and OpenRouter's Gemma chat models state none) refuses the first photo, or the pages of the first PDF reading that need it (a server that takes no WebP, on Android or desktop Chrome, say); the next reader is asked, and with none the model is told "It couldn't be described" with the provider's words. Since reader-limits-next a refusal the rules read is saved on the reader's record, so the next photo and "read it again" fit, with two exceptions where each photo is refused again: a task helper's photos when every model of the half sees photos, and a refusal the rules can't read. Each refusal costs one request and no wrong answer; the fix in hand is that model's Photo limits on its page in Settings → Models.
- **Why:** retrying the reader in place, or shaping every copy by every reader, would add a second repair path for a side job, or change what the main model is sent in setups that don't need it; no model reads an unfamiliar refusal for a reader, which may be Utility itself.
- **Revisit when:** a trace shows a reader refused for a photo's format or size, or a model added by hand is used as a reader.
- **Approved:** 2026-11-25, chief's decision C242 (not the user's words), Q-AE option (1); undo: "fold the task helper's model into the limits".

### A photo sent to a live Koe isn't made for the live model's own photo limits
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime on a model whose record says it takes only some formats (OpenAI's `gpt-realtime-2.1` and `gpt-realtime-2.1-mini`: JPEG and PNG), a camera photo sent while Koe is live goes to the session as the request copy made for Koe · Chat's and Main's models: WebP on Android or desktop Chrome. Whether OpenAI's realtime service refuses or ignores it is not verified (no network). Not the user's setup (an iPhone makes JPEG; their live model is Gemini's, whose record states no limits). From reading the code (reader-limits-next's fix round, 2026-11-25).
- **Why:** the photo is copied by the Koe agent's `#copy`, whose `#mainImages()` (src/core/agent/loop.js) reads the `koe-classic` and `main` lists, never `koe-realtime`; src/core/koe/live.js `send` checks only that the live model takes images. The fix: Koe's half also folds in the `koe-realtime` models that take photos.
- **Revisit when:** its row in docs/progress.md, in the next version.

### A plugin is switched off by annai only after three counted failures in a row with nothing of it working in between, or when its hooks run away
- **Kind:** known limitation.
- **What the traveller sees:** a plugin is switched off, with a card saying why, when its parts fail three times in a row with nothing of it working in between: its code breaks, a part it makes (Shiori's look, the dock, or a setup panel) can't be used, or its own model request or reply goes wrong. It is also switched off at once when it loops (its hooks are handed more than 1,000 log entries in 10 seconds). It stays off until the traveller turns it on in Settings → Plugins, or a tap that needs what it provides turns it on (such as adding a model), or annai starts again. No failure turns the traveller's own switch on or off. A plugin that doesn't start shows a "didn't start" card at each launch until the traveller turns it off in Settings → Plugins, and while such a start hangs, Shiori waits up to 10 seconds for each such plugin before she answers. Other failures leave the plugin on with no card: a tool's error is told to Shiori; a failing hook, dock button or picture of Shiori is a line in Trace; a section the plugin draws stays hidden. A plugin of which one part keeps breaking while its other calls keep working stays on too (a live voice plugin that can't take the traveller's voice but answers otherwise keeps going, and Shiori can't hear the traveller). The traveller can turn any plugin that stays on off in Settings → Plugins. Trace can fill with one plugin's lines when its errors keep changing.
- **Why:** a start is never counted because a start can fail on a weak link as readily as on a bug, and any error but a crash can be the link's (each of annai's own APIs answers in a shape of its own): a switch-off for a link's error cost a working plugin on a bad link (on an iPhone three launches fit in one drive). Before plugin-fails-next (2026-11-26) annai counted launches: at the third counted launch it wrote `enabled: false` into the traveller's own switch, and it turned annai's own plugins off where their files didn't load on three launches (measured in the design check). Counting a start in a run would switch a plugin off for a launch and two setup taps in WebKit's words for a failed import, which U148's "a broken plugin shows its card at each launch" doesn't say. A crash is an error the engine names for a program's mistake (a `TypeError`, a `ReferenceError` and the like, or a `DOMException` for a bad selector, `atob` on bad input or `structuredClone` of a function), or a value thrown that isn't an error, a browser `Event` among them (its own Deferred entry); beside it counts what annai itself finds wrong with what a component's `create()` or a provider's panel returned (no element; for an avatar, no `setState` or `setLevel`). A bad address that `fetch` or `new URL` refuses (a `TypeError` in the engine's words) is an answer, WebKit's "URL is not valid or contains user credentials." among them; a socket's or an `EventSource`'s bad address is the engine's `SyntaxError`, which counts. A provider's own request and reply count by where a failure happens, not by its words (spec §5.5; docs/plugins.md, "Errors" under "Protocols (endpoint types)"): a `new URL` that throws in its request builder counts there, where in a tool it is an answer; a provider's `classify` is part of that call (a crash in it counts against the provider, any other throw of it against the plugin that owns the endpoint type, which may be another plugin); and a third-party run type's own connection failure counts there too (its own Deferred entry). A request the browser refused in words annai doesn't know counts as a crash elsewhere, for that run only. What ends a run is a call of the plugin's that annai made and that returned (the design check U148 took): a tool's, a hook's, a drawing's, a dock action's, an avatar's and an endpoint type's calls did before plugin-fails-next; now a provider's `list` that gives an array, its `headers` and `classify` (whatever they return), its sign-in, a backup place's call, a trigger's check, a live session that is ready, each message it takes and each driver call, and heard clips do too. A provider's `list` that gives no array counts nothing and ends no run (the protocol's list answers, with one line saying what the plugin gave), and its `headers` that give no object add no header and count nothing; that call's return now ends the plugin's run (on main it did not). Counting the headers one switched a working provider off at its third model call (measured in the re-review of plugin-fails-next's fix pass 1: a working request credits the endpoint type's owner, never the provider), and the list's would at its third list (by reading). A switch-off takes the whole plugin, so it is for one of which nothing works; a count per part would need every part to report its own successes. A setup tap that needs a plugin switched off after its failures turns it on again (the traveller's own tap). A load that ends after the 10 seconds runs no `activate()`, and one that began in time has its registrations taken down. plugin-link-next's design check measured on main 9 of 15 start shapes and 7 of 13 hook shapes switching a plugin off without a crash. Before plugin-fails-next the dock put annai's own avatar in place of a third-party one after three throws of any kind, and every throw was a Trace line; now an error is not written again while it repeats, a crash's line carries its count (1 to 3), and the next error after the switch-off is one line with none; what changes at each call is a line each, by chief's decision C260 (not bounded).
- **Revisit when:** a traveller reports a card at every launch, or a plugin (or part of one) that keeps doing nothing, or a Trace that fills with one plugin's changing words, that they couldn't act on.
- **Approved:** 2026-11-25, chief's decision C240 (not the user's words), Q-AB option (1); widened 2026-11-26 with the user's answer U148, "All three (Recommended)", whose design check proposed this widening (a start of any kind never counted, a plugin of which one part keeps crashing while another works, the engine's words, WebKit's fetch words among the address answers, what ends a run); the Trace sentence for words that change: chief's decision C260 (not the user's words), 2026-11-26. C240 said the other way for three switch-offs that predate it: its text said a plugin that keeps failing without a crash is never switched off, and the code, as on main, switched off a plugin whose hooks ran away, one whose provider request or reply failed in its own words, and one whose component annai couldn't use; the first sentence now names all three. Undo: "keep counting the 10-second start limit" (C240's), and U148's and C260's own.

### A photo in a message Google refused can be uploaded again though it isn't sent
- **Kind:** known limitation.
- **What the traveller sees:** with Gemini and photo uploads on (not the user's setup), when Google refuses a message with a photo (its safety filter) and that photo has no live upload (uploads were off, its upload failed at once, or it expired), each later request in that conversation leaves the refused message out but uploads its photo once before it goes: the photo's bytes on mobile data, at most once per 47 hours (the upload's life), or on a files service that hangs one wait of up to 120 s before the request is sent; and while uploads are held after a hang, the refused photo counts as bytes sent, so a reply there lifts the hold though no photo went, and the next new photo can cost one more 120 s wait. No answer is wrong and nothing is lost.
- **Why:** the refused messages are known only inside the Gemini plugin's request builder; telling annai's upload step which messages a provider leaves out needs a new member on the endpoint-type interface (an API change) for a rare case. Found by kept-turn-next's review (2026-11-25, reproduced; older).
- **Revisit when:** a trace shows repeated uploads at Gemini for a photo the request doesn't carry.
- **Approved:** 2026-11-25, chief's decision C241 (not the user's words), Q-AC option (1); undo: "the endpoint type names the messages it leaves out".

### A files service that hangs at every upload costs one 120 s wait a turn that brings new photos
- **Kind:** known limitation.
- **What the traveller sees:** with a provider that takes photos by upload (OpenRouter's, Gemini's, OpenAI Responses'; not the user's setup: their photos go to Anthropic, whose uploads are off by default), when its files service hangs at every upload while its chat answers, each turn that brings a new photo waits 120 s (annai's upload limit) before it is sent, then sends the photo inside the request, until the service recovers. Before upload-rest-next (2026-11-25) one cut turned uploads off until annai restarted: one wait in all, then every later photo inside the request, and uploads never came back on a link that had only failed once. Measured on the test clock by its reviews: with Koe and Kokoro (or a reader, or a task) on one provider ability, another call's answer at that endpoint between her steps lets her next closer look try again, up to one 120 s wait a step; with a provider that keeps the conversation (Gemini's, OpenAI's own), uploads come back only after a photo turn the model answers without calling a tool first (no wait is paid meanwhile; the photos go once inside the request); on a link where an upload fits 120 s but a photo inside the request doesn't, uploads may not come back until a restart or a Test, as before. The traveller can switch "Upload photos to this provider" off.
- **Why:** telling a passing hang from a lasting one needs a time base nobody has measured (RULES 11); holding uploads off only until a reply there that calls no tool answers a request that sent a photo's bytes keeps the cost at one wait a turn, and each further condition tried on that one line leaked at an endpoint several callers share (upload-rest-next's re-review: a turn's end is not known where the call is made).
- **Revisit when:** a trace shows repeated 120 s upload cuts at one provider.
- **Approved:** 2026-11-25, chief's decision C238 (not the user's words), Q-Z option (1); undo: "measure a base for a lasting hang" or "uploads off until a restart after one cut".

### An iPhone may end a hanging photo upload before annai's time limit, which then counts as the link's
- **Kind:** deferred.
- **What the traveller sees:** with a provider that takes photos by upload (OpenRouter's, Gemini's, OpenAI Responses'; not the user's setup: their photos go to Anthropic, whose uploads are off by default). Not verified on an iPhone: WebKit there may end a hanging upload by itself at about 60 s, before annai's 120 s limit; that counts as a failure on the link at once, so uploads stay on and each request with a new photo (per model tried, per step) waits that long again. Since upload-rest-next (2026-11-25), annai's own cut at 120 s, or a 408, 429 or 5xx, holds uploads at that provider until a reply there that calls no tool answers a request that sent a photo's bytes (or a restart, a new key or address, a Test that passes): the photo cut goes in the request there from then on, and the next new photo is uploaded again after that reply.
- **Why:** found by fail-owner-next's review (2026-11-23), narrowed by llm-rest-next and upload-rest-next (2026-11-25). What is left: once a phone trace shows how an iPhone ends a hanging upload (`trace.upload`'s `ms` near 60,000 with status 0), whether a failure is decided by its time rather than its place.
- **Revisit when:** its row in docs/progress.md, with a phone trace of a hanging upload.
### Voice going off while Koe says a recap loses the rest of it
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime, the traveller asks aloud for a recap (or a watch with no reminders fires) and voice goes off while Koe is saying the answer (the chip, or auto mode as the car stops): the answer stops where it was cut ("Recap: the museum,"), and nothing says or shows the rest. On main too. Found by voice-off-next's re-reviews (2026-11-25, probed on the branch and main).
- **Why:** such a wake goes into the session as text (`#say`) and is tracked nowhere once it is in, so the close cuts the answer and has nothing to hand on, unlike a reminder or a note, which it keeps. The fix: the close hands a cut recap on as a reminder's copy is (Koe · Chat or Kokoro answers it in text), which needs `#say`'s items kept until their answer ends. Beside it (voice-off-next's touch, 2026-11-25, by reading; on main too): a recap asked aloud whose wake fails before any hand-on (a read of the refresh failing in `Halves.wake`, or `#keepFor` when the recap is for another conversation; a recap asked aloud skips the budgets' check) is lost too, since that catch shows a wake's reminders only; the fix there is the touch's `#liveFailed`.
- **Revisit when:** its row in docs/progress.md, in the next version.

### Start fresh while a note of Kokoro's waits for Koe's open lands it below the divider
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime, Kokoro's answer for the traveller arrives while Koe's side is still opening (no session yet), and the traveller taps Start fresh in that moment: Koe later says the answer in the fresh conversation, below the "Started fresh" divider, where the spec puts Kokoro's owed words above it. On main too. Found by voice-off-next's second opinion (2026-11-25, probed on the branch and main).
- **Why:** `#live` waits on `koe.opening` before it hands anything to the live session, so a close in that wait doesn't see the note. The fix: `#live` asks whether Start fresh came during that wait before it goes on; the switch tests lean on the order, so it is its own change.
- **Revisit when:** its row in docs/progress.md, in the next version.

### A microphone start that never settles holds what waits for the live session
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime, if the microphone's start never settles (the browser's `getUserMedia` waiting on a permission prompt nobody answers, say) after the traveller tapped the session away during it, a reminder or a note of Kokoro's that waited on that session stays out of later sessions too until one of them closes by itself (its quiet spell), and is then shown. Found by voice-off-next's round-2 re-reviews (2026-11-25, probed with a start held open; a phone's own start is bounded by its capture's waits, by reading).
- **Why:** since voice-off-next nothing that waits goes into a session while a placement still waits for its session to listen, and a tap's close leaves that wait to end by itself; `getUserMedia` (src/plugins/voice-browser/index.js) has no time limit. The fix: a time limit on the microphone's start in the plugin, as its resume already has (RESUME_MS), its number from a phone measurement (RULES 11), a stream that comes after it stopped.
- **Revisit when:** its row in docs/progress.md, with a phone measurement of a microphone's start.

### Kokoro's final text for Koe is dropped when no live session can take it and Koe stays live
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime, when no session can take a note of Kokoro's meant for Koe (the day's spend reached, or an open that returns no session) and Koe stays live, Kokoro's final text is said by no one and shown nowhere, so her answer to the traveller's question is lost; "nothing to add" and "stopped" are dropped too, which loses nothing. On main since before voice-off-next. Found by the design check of `#go`'s failure path (2026-11-25, measured with the day's spend reached and with an open that returns false).
- **Why:** `#live`'s fallback, when Koe stays live, gives a note to `#backstop`, which shows only a note's words for the traveller, and to `#annai`, which does nothing for a note without them. The fix: a final text that no session takes is shown as Kokoro's answer ("Shiori's answer"), as a note for the traveller is; plan decision 21 (Kokoro's error turns told by Koe, no card while Koe works) is about her error turns, not her answer.
- **Revisit when:** its row in docs/progress.md, in the next version.

### A refused read while a live session connects rests the live model for 3 minutes
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime, when the phone refuses a read of annai's own store during the session's setup (rare; two refused reads in one open since open-reads-next, which passes over a refused spend or settings read), the connection fails and the live model rests for 3 minutes; Koe's next model or Kokoro answers meanwhile, so nothing is lost, but live voice is off for that time. On main for a refused setup read alone. Found by open-reads-next's final review (2026-11-25, probed). The same rest follows a connection that fails after the traveller's tap or the page going out of view closed the open it belonged to (its re-reviews, by reading; on main too): the close, not the provider, ended it.
- **Why:** `#start`'s catch around `#resume` (src/core/koe/live.js) rests the model for any failure. The fix: rest it only for the provider's failure (an error with a provider's `kind`) of an open still wanted (its `gen` still current), not for annai's own refused read; check first that every provider error carries one.
- **Revisit when:** its row in docs/progress.md, in the next version, or when a trace shows a refused read beside a live open.

### A tap that stops a connecting live session doesn't keep its reminder for the next session
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime, the traveller taps Shiori to talk, a reminder joins the session while it connects, and the traveller taps again to stop it: annai shows the reminder and says it when the connection attempt ends (up to 15 s), where the user's pick says a tap's close keeps it for the next session and nothing is said at the tap. On main too. Found by voice-off-next's reviews (2026-11-25, by reading; the branch keeps main's timing for a tap).
- **Why:** a session's waiting items stay for the next session at a tap, but an item `#go` still waits to hand in is placed by `#live` when the attempt fails. The fix: a tap's close hands what `#go` waits on back to the session's waiting list, and `#go` says so, so `#live` places nothing. The user's words: the floor pick (2026-11-12, spec §6.8 "One input at a time": one closed by the user's tap keeps it for the next session, annai neither shows nor says anything of it at the tap).
- **Revisit when:** its row in docs/progress.md, in the next version.

### A line typed as another conversation opens while the live session connects can be answered there
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime, the traveller types a line while the live session connects and opens another conversation before it goes in: the line is logged in its own conversation but goes to Koe (her text queue or the session) in the conversation opened, so her answer about the trip left comes in the trip opened. On main too. Found by voice-off-next's second opinion (2026-11-25, by reading, not probed).
- **Why:** a typed line carries no conversation (`Halves.send` passes none to `#live`), so `#elsewhere` can't see it has left; the entry `live.write` returns has its `scope`, so the stamp is one line. The fix: stamp it and keep it in its own conversation (unanswered there), as a note is.
- **Revisit when:** its row in docs/progress.md, in the next version.

### With OpenAI Realtime, a tap while her reply is still being made with no sound yet cancels nothing there
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime on OpenAI's Realtime (not the user's), a tap that stops Koe while her reply is being made but before any of its sound has played sends OpenAI no cancel, so the reply runs on there (its tokens billed) and its calls still reach annai, and until that reply's `response.done` the plugin holds what Koe sends, the traveller's microphone included, so their next turn can wait behind the whole reply. Found by realtime-cut-next's reviews (2026-11-25, by reading: `interrupt()` in src/core/koe/live.js sends the cut only when her voice was sounding). Beside it, for the next change to the plugin: its header comment still states Gemini's order as fact (not measured on the real service).
- **Why:** a tap's cut is sent from the turn's sound; a reply that has no sound yet has none to cut. The fix: a tap cuts the reply being made too; to check with the OpenAI Realtime run (its row).
- **Revisit when:** its row in docs/progress.md, with the OpenAI Realtime run.

### The token rule counts the window's PDF pages, which no summary removes
- **Kind:** deferred.
- **What the traveller sees:** a PDF whose pages come to about 100,000 tokens by the provider's own count makes the conversation due at each cold return while the PDF stays in the window, though a summary can't make it smaller (it leaves after two turns either way). Found by the forced-branch design check (2026-11-25); what is left of "What 'Largest request' still decides" after size-out-next (2026-11-26) took the field out.
- **Why:** the token rule weighs the whole request, its PDF pages included; a trigger should weigh what its action can change (size-forced-next's lesson). The fix: the due point leaves out the window's PDF pages, as the estimate already counts a PDF as one picture.
- **Revisit when:** its row in docs/progress.md, in the next version.
### A file filed in a turn that then failed still counts as waiting on the trip's card
- **Kind:** deferred.
- **What the traveller sees:** Shiori reads a file handed to her (or moved to another trip) and files it (a booking made from it), and her turn then fails (the reply that says so gets no answer, or a Stop): the trip's card says "1 file waiting to be read" while its Files list shows the booking. Nothing wakes her for the file again (spec §6.7), so the count stays until the traveller writes or speaks there and a turn of hers ends. Found by files-wait-next's re-review (2026-11-25, a probe on the real loop); the Fable final review's note 9 is the same shape: after a failed turn nothing wakes her for a waiting file, so the 2026-10-28 spec's "the next time the trip is opened" holds only for the first open. It leans the safe way: the row itself is right.
- **Why:** the card (src/ui/screens/trips.js about :212) counts `filesToRead`, while the Files row (src/core/trip-files.js about :111) shows a booking made from a file before "waiting": two answers to one question (RULES 10). The fix at the source: one rule for "waiting" that both use (the card counting the rows that are waiting).
- **Revisit when:** its row in docs/progress.md, in the next version.

### When her turn has ended is stated in two places
- **Kind:** deferred.
- **What the traveller sees:** nothing today: `endsHerTurn` (src/core/agent/log.js), which a file's wait asks, and Transcript.apply (src/core/agent/transcript.js about :268-282), which the conversation reads, agree on every real log through the project's history (files-wait-next's re-review, 2026-11-25). A new way for a turn to end that only one of them learns would make a file's wait and the conversation disagree.
- **Why:** one function, `endsTurn(e, half)`, used by Transcript's `turn.end` and older-reply branches with `endsHerTurn` as its Kokoro or one-Shiori case (docs/lessons.md, 2026-11-17: a second answer to the same question); about five lines in the state machine every conversation reads, so its own change and review.
- **Revisit when:** its row in docs/progress.md, in the next version.

### A tap while a stopped live open is still connecting is lost
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime, they tap Shiori, tap again to stop (or a bump taps twice), then tap a third time while the stopped attempt is still connecting: the third tap says "listening" and the dock "One moment…", then she is asleep and nothing listens; a fourth tap listens. Nothing but that tap is lost; by reading, something waiting for the page to come back waits for the next open in the same moment. On main too. Found by open-reads-next's re-reviews (2026-11-25, probed in the reads and the connection's setup read).
- **Why:** `open()` (src/core/koe/live.js) reuses `#opening` while it is set, and `#start` returns false for a closed generation, so the third tap takes the stopped attempt's "no". The fix, in `open()`: a call made while a closed generation's start still runs waits for it, then starts its own.
- **Revisit when:** its row in docs/progress.md, in the next version.

### A heard line whose clip setting can't be read as it is saved isn't written
- **Kind:** deferred.
- **What the traveller sees:** with the turn's sound kept in memory (Keep voice clips on, or a Detailed trace asking for sound), when the phone refuses the settings read at the moment a heard line is saved (rare), the line isn't written to the conversation and the "wasn't saved" card shows; the words the traveller said are missing from the log. On main too. Found by open-reads-next's re-read (2026-11-25, by reading).
- **Why:** `Voice.keep` (src/core/voice/voice.js) reads `keepClips` with no catch, and its rejection fails the heard line's write. The fix: a refused read means no clip, and the line is written (`(await this.settings().catch(() => null))?.keepClips`), with a test.
- **Revisit when:** its row in docs/progress.md, in the next version.

### With every spend read refused, a live session doesn't stop at Spend per day
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime and a Spend per day set, while the phone refuses every read of today's spend (rare: the store failing its reads), a live session opens and runs past the day's cap; it stops once a read goes through. Since open-reads-next a refused read at the open counts as under the cap (one turn past it, as a running session's usage check already did on main). Found by its re-read (2026-11-25, by reading).
- **Why:** `#over` (src/core/koe/live.js) and the session's usage check pass over a refused read. The fix: the session counts what it spent since it opened, so a refused read can't take it past the cap by more than the day's spend before the open.
- **Revisit when:** its row in docs/progress.md, in the next version, or when a trace shows the spend read refused.

### A typed password in a third-party plugin's address reaches its trace and error words in Chromium
- **Kind:** deferred.
- **What the traveller sees:** a third-party plugin (no official one) fetching, through `annai.net.fetch`, an address its own setting holds as `https://name:password@host/…`: in Chromium the request is refused and the engine's words, which quote the address whole, are kept in the trace's error field and in the error the plugin gets, and so in what Shiori is told if a tool's answer carries it (the trace's `url` field is blanked). WebKit's words hold no address. Since addr-small-next no typed address of annai's or of an official plugin gets that far. Found by its final review (2026-11-25, measured in Node through the real `tracedFetch` with Chromium's measured words).
- **Why:** `tracedFetch` (src/core/agent/net.js) blanks stored secrets and credential shapes, not the requested address's own name and password. The fix, at source: blank them as `src/core/llm/trace.js`'s `urlSecrets` already does for a model call, with its own review.
- **Revisit when:** its row in docs/progress.md, in the next version.

### A plugin switched off mid-session keeps driving its open live session
- **Kind:** deferred.
- **What the traveller sees:** a third-party live voice plugin (no official one) switched off for crashing while one of its sessions is open: the card says it was turned off, and its open session goes on talking until it closes, every message still handled by the plugin's driver. Found by the plugin-failure design check (2026-11-26, measured: 50 crashes in one session all handled by the same driver after the switch-off at the third).
- **Why:** the registry stops the plugin and takes its type out, but the session holds the type. The fix: the live service closes a session whose plugin is switched off.
- **Revisit when:** its row in docs/progress.md, in the next version.

### A reply's late call, end or sound that crosses an input ends that input's wait
- **Kind:** deferred.
- **What the traveller sees:** with Koe · Realtime, an input goes in while her reply is still arriving (an urgent reminder or a note that cuts her in, or a line typed or a choice tapped while she talks), and then the link dies with its socket up. If a card's call of that reply (Gemini and OpenAI), its own turnComplete already on its way (Gemini only), or, for a typed line or tapped choice the page didn't cut her for, the late sound of her reply arrives after the input went in, the input is taken as answered: no fresh session gets it, and she never says it. A reminder comes late, at the quiet spell's close (or about 16 s after a call she speaks after), shown and, with voice on, said in annai's own voice (with Koe on text, Koe's text takes it): never lost. A typed line or tapped choice is left unanswered, with nothing that says so. On main a cut turn on a dead link held the session for ever instead. Found by cut-bound-next's reviews (2026-11-25 and 11-26; the call and end orders measured on main and on the branch by the final review, the sound order by re-review 2's probe).
- **Why:** nothing on the page tells a late call, end or sound of a reply from one made for the input, so `#answers` (src/core/koe/live.js) counts it as the answer to a text wait. A third carve-out in `#answers` would miss the next order (each review found one); the fix starts with a design check of one rule, "a wait is answered only by a turn of hers that began after its input went in" (`#passes` and `#settle` already use it for notes), weighing `due.alive` (a slow session would get a fresh one rather than be asked again), the tails of turns Koe ended early, and OpenAI, where a typed line doesn't cut her.
- **Revisit when:** its row in docs/progress.md, in the next version, its design check first.

### With route (c1), nothing on screen names the transcription model that can't hear
- **Kind:** deferred.
- **What the traveller sees:** with a main model that takes no audio and a transcription model that fails without resting (unreachable, hanging, refusing: a self-hosted server whose tunnel is off among them), every line they say gets Shiori's "Could you say that again?" and nothing points at Settings → Models; before route (c1) each line showed "Nothing in the speech-in list worked for …". A model that rests (down, rate-limited, out of credit) stops it by itself: the next tap can't listen. Found by clip-route-next's final review (2026-11-26, probed with two lines).
- **Why:** the card was the only place that named the model; the stand-in reaches her as "[audio, not transcribed]" with nothing saying why. The fix: one line of the system text saying what that means (annai couldn't get it transcribed; say so, typing works, the transcription model may be out), checked once with a real model (RULES 12).
- **Revisit when:** its row in docs/progress.md, in the next version.

### A hanging transcription model keeps her busy longer with each line not yet written down
- **Kind:** deferred.
- **What the traveller sees:** with a transcription model that hangs (no answer in its send's time) and a main model that takes no audio, after her answer to a spoken line she stays busy one more hang for each line not yet written down: about 48 s after the first line, 72 s after the second, 96 s after the third at C212's 24 s, a line said meanwhile waiting behind it. Before route (c1) each line cost one hang, then the card. Found by clip-route-next's final review (2026-11-26, measured with 300 ms standing for the send time).
- **Why:** each write-down of each line asks the hanging model again with a fresh cut list (`Voice.writeDown` → `#resolve`, src/core/voice/voice.js), and the write-down is awaited inside the turn. The fix, at source: one cut list for a whole write-down pass, so a hang costs one wait a pass.
- **Revisit when:** its row in docs/progress.md, in the next version.

### An urgent reminder that opens a Live session and is answered by a card alone is not heard in that session
- **Kind:** known limitation.
- **What the traveller sees:** with Live voice, an urgent reminder (a watch marked urgent) that opens a session with nobody in it, answered by Koe with only a card: the urgent mark holds the microphone shut for its 8 s with no voice, and the session it opened listens 8 s, so it closes without hearing anything (the probe: "Thinking" for 8 s, then closed); the reminder counts as told by the card. With the traveller already in the session the microphone is deaf for those 8 s, then hears (by reading). The same 8 s makes an ask once more wait after an empty answer to an urgent reminder.
- **Why:** it is the urgent mark's recorded design (2026-11-02, section 6: "an answer with nothing or a silent tool frees the microphone at 8 s"); the two ways measured to match the mark to her turn are worse: one fails 9 of the mark's own tests, the other loses a reminder in C213's shape, written as told, never said or shown. How often Gemini answers an urgent reminder with only a card is not measured.
- **Revisit when:** a drive shows an urgent reminder answered by a card alone.
- **Approved:** 2026-11-26, the user picked "Accept it (Recommended)" (U145, through chief's dialog). It narrows their pick of 2026-11-03 for urgent watches ("Yes, after the mic fix (Recommended)") for a card-only answer.

### A large PDF goes whole in each request of its two turns
- **Kind:** known limitation.
- **What the traveller sees:** a PDF Shiori reads goes in each request of her turn about it and the next, then a stub naming its file (her read brings it back). A photo's copy is capped at 256 KiB; a PDF has no cap, so a 1 MB PDF read in a turn of four steps goes up four times at about 1.4 MB each, then in each request of the next turn, the size that broke off on a car's mobile data (2026-11-21). The trace's PDFs (sizes only): 6 written, 80 KB to 2.0 MB, median 139 KB.
- **Why:** most PDFs are small, and the window already took a PDF from every request down to two turns; a smaller form needs a design (a large PDF sent as its reading's words, which a model that reads PDFs then reads less well).
- **Revisit when:** a trace shows a large PDF's turn failing on a weak link.
- **Approved:** 2026-11-26, the user picked "Accept, with a README line" (U116, through chief's dialog). It narrows their words of 2026-10-19, "we are an agent on the go possibly with spotty internet. thus we shall make these optimizations when possible", for large PDFs. Its words changed to what is built on 2026-11-26: the request size went (U141).

### A voice made for one language reads every sentence in it
- **Kind:** known limitation.
- **What the traveller sees:** a voice from a provider gets one voice name for every sentence and no language. A multilingual one follows the text; one made for one language (Kokoro's English `af_heart`, Voxtral's English voice) reads a Japanese or Chinese sentence in its own language: a Japanese sentence of about 11 s came back as a 64 s clip of noise (the probe of 2026-11-19), and nothing flags it (the clip comes back fine to annai, and Test says it works). It takes such a voice put ahead of the phone's own voice in Settings → Models → Speech out (no default does), or a Test on Japanese or Chinese screens.
- **Why:** nothing in the defaults or the trace reaches it (none in 28 days); one voice for every sentence keeps no state that can go stale; the local speech note says each Kokoro voice speaks only its own language.
- **Revisit when:** a traveller puts a one-language voice ahead of a multilingual one and hears it.
- **Approved:** 2026-11-26, the user picked "Accept, with a README line (Recommended)" (U112, through chief's dialog). It narrows their words of 2026-10-23, "I personally speak english chinese and japanese so multi language in audio shall be supported", for voices made for one language.

### While a reader's or a transcription's bytes go up for her turn, the dock says Thinking
- **Kind:** deferred.
- **What the traveller sees:** since U113's build the dock says "Sending… · tap to stop" while her turn's own request carries a photo's, a PDF's or a recording's bytes up. Requests made for her turn by others still say Thinking while their bytes go up on a slow or dead link: a reader that reads a PDF or describes a photo for a model that can't take it (also after a cut send, for the next model in the chain), and a transcription of a recording for a model that takes no audio (Claude takes none, so with voice on in the user's setup every recording goes up through one, bounded by its own 15 s wait). Housekeeping's calls never say Sending… either: their dock says "Working on tidying up the conversation". A plugin's own run type says nothing. Koe · Live's photo goes up its own socket and its states are its own.
- **Why:** only her turn's call reports to the dock, and callOnce says `sending` only for a request it makes itself (sending-next's reviews, 2026-11-26). The reader's part is small (the loop passes its `onEvent`, filtered to `sending`, to `readFile`'s calls); the transcription's is speech.js and voice.js telling the loop, in voice files clip-route-next changes too.
- **Revisit when:** its row in docs/progress.md, in the next version, after clip-route-next is merged.

### The strings tool can't keep a row only a released version still uses
- **Kind:** deferred.
- **What the traveller sees:** nothing. The rule (docs/translating.md: never drop a row an older version still uses while it is in use) is kept by hand: a plugin keeps an uncalled export that says the words (plugins-official/provider-another-address/probe.js, `retiredWords`, until its 2.2.3 is out of use), since scripts/strings.mjs builds the rows only from what the code says. Found by addr-small-next's fix round 2 (2026-11-26).
- **Why:** a workaround in our own tool's gap, in one place. The fix at source: a "retired rows" marker the strings tool keeps until a stated version is out of use.
- **Revisit when:** its row in docs/progress.md, in the next version.

### With Keep my music playing on, a tap in the second before Shiori answers a reminder under Live listens instead of stopping her
- **Kind:** deferred.
- **What the traveller sees:** with Live voice and Keep my music playing on, a reminder, an urgent watch or an urgent note of Kokoro's opens a live session with no microphone (so the music plays on). If the traveller taps Shiori in the second or so after it went in and before her answer has begun (the dock says "Thinking · tap to stop"), the tap opens the microphone and she says the reminder and listens, which stops the music; with the switch off (and on main) such a tap stops her, closes the session and shows the reminder on a silent card, the user's pick of 2026-11-12 ("a tap means stop, and the card stands", spec §10.8). Found by the music switch's second re-review (2026-11-26, probed in real time).
- **Why:** `tap()` in live.js reaches its stop branch only through an open microphone (`listening`, `#input`), and a session opened by itself with the switch on has none. The fix found (two lines: a reminder not yet begun counts for the stop branch, 1419 of 1419 unit tests passing with it in a scratch copy) waits for the design check RULES' step back asks for: every code finding since the final review landed in Live's self-opened sessions (F1, R1, this one), each from Live code that decides by whether a microphone is open rather than by what she is doing.
- **Revisit when:** its row in docs/progress.md: the design check (Live's decisions by an open microphone), then the fix, in the next version.

### With a server that sends nothing until its answer is ready, a request with a photo, a PDF or a recording says Sending… for the model's whole wait
- **Kind:** known limitation.
- **What the traveller sees:** the dock says "Sending… · tap to stop" from the moment a request that carries a photo's, a PDF's or a recording's bytes starts going up until its answer's headers come, then Thinking (U113's build). A server that sends its headers only with its first words (a router that never streams; maybe some local servers and proxies, not verified) then shows Sending… while the model thinks, on any link, and never Thinking; before U113's build it said Thinking. Claude on Anthropic's API streams. One model in the user's own list went through such a server: the trace (counts only) has 13 model requests through the maiGo router's Gemini between 2026-11-21 and 11-23, all failed (unreachable, cancelled, timed out), and the project's notes say that router doesn't stream (not measured again here); the user's question on it is in docs/progress.md's Waiting list. The card for such a send already says the connection may be too slow to send photos or files, so the dock and the card agree.
- **Why:** a browser's `fetch` gives no sign that a request's body is up other than the answer; telling the two apart needs XMLHttpRequest's upload events, a rewrite of how annai sends requests (sending-next's final review, 2026-11-26).
- **Revisit when:** Sending… is seen on a good link, or the user's answer on the router's model says so.
- **Approved:** 2026-11-26, chief's decision C256 (not the user's words), Q-AM option (1), on the condition that the trace be checked for a model of the user's through a server that doesn't stream (it found one: the question is the user's); to undo: "leave the Sending… wait an open finding".

### Koe's own resting audio model is passed over before Koe answers a heard line as not heard
- **Kind:** known limitation.
- **What the traveller sees:** with Koe · Chat whose list has an audio model that is resting (and a text one), and the transcription model out, when Kokoro has no ear (no main model of hers that takes audio, or "Send audio to the model" not in the speech-in list) or her last turn's call failed and no turn of hers has worked since: Koe's text model answers the heard line as one she couldn't hear, without asking Koe's resting audio model, and after three of Koe's turns that worked the line is stored that way.
- **Why:** the spec's rule (§9.6) says that in Shiori's own turn "a model resting after an error isn't passed over" and that "at most one resting model is asked in the call"; the code never asks a resting model in Koe's list, as Kokoro answers when Koe can't, so asking Koe's resting audio model before the stand-in would reverse that for a shape that needs an audio model in Koe's list resting while the transcription is out. The line is answered; its words are given up after three turns that worked. Before route (c1) this shape ended in a card and the sound stayed for a later try. Found by clip-route-next's re-review (2026-11-26); the clause on Kokoro's last turn's call came with route (d).
- **Revisit when:** a traveller meets it and minds, or Koe's rule for who takes the last pass changes again.
- **Approved:** 2026-11-26, chief's decision C257 (not the user's words), Q-AL option (1); to undo: "Koe asks one resting model before its stand-in". Widened to route (d)'s condition 2026-11-26, chief's decision C259 (not the user's words), Q-AP option (a).

### After a call of Kokoro's failed, each heard line said before her next working turn is answered by Koe as one she couldn't hear
- **Kind:** known limitation.
- **What the traveller sees:** with Koe and Kokoro, a main model of Kokoro's that takes audio, "Send audio to the model" in the speech-in list, and the transcription model out: after a turn's call of Kokoro's failed, and until a turn of hers works, Koe answers each heard line first as one she couldn't hear, though Kokoro's model may then answer it from its sound. With three such lines said before Kokoro's turn ends, the first is stored as "[audio, not transcribed]" at Koe's third turn that worked and its sound let go.
- **Why:** route (d) reads how Kokoro's last turn's call ended instead of forecasting whether her call will hear the line (the forecast drew every finding of three fix rounds; RULES' step back and the design check of 2026-11-26). Koe answers before Kokoro's call runs, so the read is a guess that Kokoro's next working turn corrects. Removing it needs a record that Kokoro's last call answered only through the last pass, one more part. Before route (d), each such line was answered from its sound. The user's own setup doesn't meet it: their main model takes no audio, so Koe always takes the last pass there.
- **Revisit when:** a traveller with a main model that takes audio meets it, or the user says "record that Kokoro's last call answered only through the last pass".
- **Approved:** 2026-11-26, chief's decision C259 (not the user's words), Q-AP option (a), its item (1); to undo: "record that Kokoro's last call answered only through the last pass".

### A typed line after a heard line Kokoro answered but couldn't write down fails with the card for both halves when her next call fails too
- **Kind:** known limitation.
- **What the traveller sees:** with Koe and Kokoro, a main model of Kokoro's that takes audio, and the transcription model out: after a heard line that Kokoro's call answered from its sound but nothing wrote down, a line typed when Kokoro's next call fails too fails with "Shiori can't reach her model" for both halves. The line where Kokoro's call first fails shows that card for both halves only when Koe's call has failed since her last turn that worked; after a restart it shows Kokoro's own card instead.
- **Why:** in this shape (Kokoro has an ear) Koe takes the last pass only when Kokoro's last turn's call failed; Kokoro's answer from the sound is a turn that worked, so the next line goes to Kokoro first. Before route (d) the typed line was answered. The user's own setup doesn't meet it (their main model takes no audio). It is bounded by Kokoro's next outcome, and every route that removes it changes what the traveller hears when Kokoro's model works, or adds a part.
- **Revisit when:** a traveller meets it, or Koe's rule for who takes the last pass changes again.
- **Approved:** 2026-11-26, chief's decision C259 (not the user's words), Q-AP option (a), its item (2); to undo: "record that Kokoro's last call answered only through the last pass".

### With Kokoro's audio model out and a text model of hers working, Kokoro answers heard lines as not heard and Koe is passed over
- **Kind:** known limitation.
- **What the traveller sees:** with Koe and Kokoro, Kokoro's audio model out (out of credit or resting) ahead of a text-only model of hers that works, and the transcription model out: Kokoro's text model answers each heard line as one she couldn't hear, and Koe is passed over until the line is given up (after three turns that worked of the half that writes it). Every line is answered.
- **Why:** Kokoro's settings give her an ear and her last turn's call worked, so route (d) doesn't hand Koe the last pass; Koe's answer would be the same not-heard answer, sooner. The user's own setup doesn't meet it (their main model takes no audio).
- **Revisit when:** a traveller meets it and minds.
- **Approved:** 2026-11-26, chief's decision C259 (not the user's words), Q-AP option (a), its item (3); to undo: "record that Kokoro's last call answered only through the last pass".

### A call outside Kokoro's turn that found her shared audio model out of credit leaves the next spoken line failing with the card
- **Kind:** known limitation.
- **What the traveller sees:** with Koe and Kokoro, an audio model Kokoro shares with the utility role, and the transcription model out: when a call outside her turn (a recap, a title) found that model out of credit before any call of Kokoro's failed, the next spoken line fails with "Shiori can't reach her model"; the lines after it are answered.
- **Why:** route (d) reads only how Kokoro's own turn's call ended; a call outside her turn doesn't count. One line, bounded by Kokoro's own failure on it; the same before route (c1). The user's own setup doesn't meet it (their main model takes no audio).
- **Revisit when:** a traveller meets it.
- **Approved:** 2026-11-26, chief's decision C259 (not the user's words), Q-AP option (a), its item (5); to undo: "record that Kokoro's last call answered only through the last pass".

### Lines typed in the minute after the first spoken line that fails, while Koe rests, fail
- **Kind:** known limitation.
- **What the traveller sees:** with Koe and Kokoro, a main model of Kokoro's that takes audio, and the transcription model out: in the minute Koe rests after her quiet failure on the first spoken line, lines typed then fail when Kokoro can't answer them either; after the minute they are answered.
- **Why:** Koe's rest after a quiet failure is the spec's "at least a minute" (§6.8), so a passing failure doesn't flap her voice; Kokoro has the voice inside it, and here her call fails too. Probed with lines typed at 5 s and 25 s (failed) and 65 s (answered); the same before route (d). The user's own setup doesn't meet it (their main model takes no audio).
- **Revisit when:** a traveller meets it.
- **Approved:** 2026-11-26, chief's decision C259 (not the user's words), Q-AP option (a), its item (6); to undo: "record that Kokoro's last call answered only through the last pass".

### A heard line nothing could write down is given up after three turns that worked
- **Kind:** known limitation.
- **What the traveller sees:** the transcription model is out (it can't be reached, hangs, refuses the recording, is down, rate-limited or out of credit) and no main model that takes audio answers the line: none does, "Send audio to the model" is not in the speech-in list, or the one that does fails or rests (a text model then answers the line as not heard: Shiori's, or, with Koe and Kokoro, Kokoro's, with Koe passed over until the line is given up); or, with Koe and Kokoro, Kokoro's last turn's call failed and no turn of hers has worked since (Koe then answers it). Shiori answers the heard line as one she couldn't hear, and a line typed after it is answered as usual, the heard line still read to her as not transcribed (with Koe and Kokoro a typed line can still fail, in the shapes the entries above name). Each turn that works tries again to write the line down (each try costs a transcription request; a model that refuses recordings is sent each unwritten line once per step of the turn and once more when it is written down). By the end of the third turn that worked of one half (each half keeps its own count), the line's own among them, it is stored as "[audio, not transcribed]" and its sound let go, whatever the cause: a transcription model that rests through all three counts, and so do lines typed within its rest (3 minutes, or what a rate limit's provider asked for). A line whose sound is no longer in the phone's memory (after a reload or a restart with Keep voice clips off, or once the 16 MB of kept sound let it go) is stored so at the next turn that works, without the count; Start fresh, and a summary that can't wait, store the unwritten lines at once; a summary annai makes on its own between turns keeps the sound and counts nothing. With Koe and Kokoro the turns that count are Koe's while she is on a text model, a turn for Kokoro's note included (none while she is live), and Kokoro's when Koe is down. A transcription model that comes back later is not given the line, and its bubble shows "[audio, not transcribed]": say it again (a new line is tried afresh).
- **Why:** the 3 is a guess from the first version (2026-10-16), not measured. Keeping the sound until a model can write it down would mean holding every unwritten line's sound up to the memory's cap, with no count. What it replaces was wider: before 2026-11-25 every later line failed with "Nothing in the speech-in list worked" until the model came back or annai restarted; now a line typed after it is answered, but in the few shapes with Koe and Kokoro that route (d)'s entries above name. The user's transcription model normally answers (the trace, 2026-11-23: 19 of 19). For a line a model heard as audio whose write-down failed, this has been the code's behaviour since 2026-10-16.
- **Revisit when:** the trace is next read: count how often a heard line reaches its third turn (chief's C261); a traveller says a line they said was lost; or the user says "keep the sound until the memory cap and drop the count of three".
- **Approved:** 2026-11-26, chief's decision C261 (not the user's words), Q-AH option (1); to undo: "keep the sound until the memory cap and drop the count of three". The user didn't ask for it.

### A trigger type's validate, start, next or describe that crashes leaves no Trace line
- **Kind:** deferred.
- **What the traveller sees:** with a plugin's trigger type whose `validate`, `start`, `next` or `describe` throws (third-party; no official plugin's is known to): a watch whose `validate` throws never fires and watch_list says its trigger can't read it; one whose `start` throws has no start-time memory; one whose `next` throws drops out of the timer and fires only at a later position fix, late; one whose `describe` throws lists the bare type name. None of them writes a Trace line or counts against the plugin; only `check` does. The same before plugin-fails-next.
- **Why:** plugin-fails-next's second opinion found it (2026-11-26, probed). Counting `validate` as a crash would run once per position fix per watch, so one stale watch could switch a whole plugin off within three fixes, worse than the silent watch; the right shape (one Trace line per watch, or a count only where a call of the plugin's own is made for the traveller) needs a look of its own.
- **Revisit when:** the next version.

### The official live plugins write one Trace note per audio chunk they can't decode
- **Kind:** deferred.
- **What the traveller sees:** when Gemini Live or OpenAI Realtime sends audio the plugin can't decode, each chunk is skipped and writes a `live.skipped` note to Trace, at audio rate while it lasts, outside the registry's repeat rule (plugin-fails-next counts and folds only the errors annai catches itself).
- **Why:** found by plugin-fails-next's second opinion (2026-11-26, by reading); no such audio is in the user's trace. The plugins write the note themselves through `annai.events.append`, so the fix is in each plugin (one note per session, or the count of chunks skipped when the session ends).
- **Revisit when:** the next version, or a trace shows these notes.

### A browser Event a plugin rejects with counts as a crash, and its words read "[object Event]"
- **Kind:** deferred.
- **What the traveller sees:** a third-party plugin whose code rejects with the browser's own event (an image or a script that wouldn't load, `img.onerror = reject`) counts a crash each time, so three with nothing of it working between switch it off; its card and Trace line read "[object Event]", and a tool's answer to Shiori "Error: [object Event]". The same on main; no official plugin rejects with an Event.
- **Why:** plugin-fails-next tried an Event as an answer in its first fix pass; its reviews found the rule held at some places and not others (a provider's own request and reply count every error by where it failed), and an `ErrorEvent`'s message lost; RULES' step back stopped further code rounds, so it came out again. About sixty places make a plugin error's words with `String(e?.message ?? e)`, each with its own verdict on whether it counts.
- **Revisit when:** the next version, with one function at the boundary that gives every caught value its words and its verdict, used by every place that catches a plugin's error.

### A third-party run type's own connection failure counts against its provider
- **Kind:** deferred.
- **What the traveller sees:** a third-party endpoint type with `run`, which makes its own request: a connection that drops on a weak link throws an error that is no `ProviderError`, so it counts against the provider, and three failed calls in a row switch it off with a card. The plugin guide tells authors to throw `ProviderError('network')` there. No official endpoint type has `run`. The same on main.
- **Why:** a provider's own request and reply count every error by where it happened (call.js `asProviderError`), and don't ask the registry's rule that a failed fetch is the link's. Found by plugin-fails-next's third re-review (2026-11-26, by reading).
- **Revisit when:** the next version: a failed fetch inside a run type's call is the link's, as the registry already reads it elsewhere.

### A start that overlaps a late activate can lose its registrations
- **Kind:** deferred.
- **What the traveller sees:** a third-party plugin whose `activate()` runs past the 10-second start limit, turned on again (or installed, or updated) while that `activate()` still runs: when the old one settles, annai takes down its registrations by the plugin's id, the new start's tools among them, so the plugin is on without its tools until annai starts again. Rare: it needs an `activate()` over 10 seconds and a start during it.
- **Why:** a start's entry is released at the time limit, before its `activate()` settles (plugins.js `start`, `#inTime`). Found by plugin-fails-next's third re-review (2026-11-26, by reading).
- **Revisit when:** the next version: keep a start's entry until its `activate()` settles.

### A plugin an older annai switched off for failed starts stays off with no card
- **Kind:** known limitation.
- **What the traveller sees:** a plugin that an annai from before 2026-11-26 switched off at its third launch that failed to start stays off after the update, with no card, until the traveller turns it on in Settings → Plugins, like one they turned off themselves; a setup tap that needs it says it "is turned off".
- **Why:** that annai wrote the switch-off into the traveller's own on/off switch; since plugin-fails-next annai never writes it and keeps no launch count, so nothing tells such a plugin from one the traveller turned off. A card would need the stored count the user's answer U148 had go. The user's trace (counts only, 2026-11-26) has no plugin switch-off events, so probably no such plugin is on their phone.
- **Revisit when:** a traveller finds a plugin off that they didn't turn off.
- **Approved:** 2026-11-26, chief's decision C262 (not the user's words), Q-AQ option (1); to undo: "one card at the next launch for a plugin an older annai switched off".
