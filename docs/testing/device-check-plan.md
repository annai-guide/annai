# Device check plan

The 13 device checklists in this folder (`device-checklist-m1.md` … `device-checklist-m9.md`, 275 items) sorted by who checks what, so you hold a phone only for the items that need you.

- **A — Emulator (Claude alone):** an Android emulator (Chrome, Android 14) in Docker on a Linux server. Claude drives it over adb and Chrome DevTools: screenshots, taps, typing, console, storage. It can fake GPS positions and routes (`adb emu geo fix`), go offline, and receive push.
- **B — Real Android, Claude drives:** your real Android phone, paired over wireless debugging. Claude drives the screen; you do only the physical parts.
- **C — iPhone in hand:** your real iPhone, used by hand, with Safari's Web Inspector on a Mac for console and storage. Claude tells you what to check.
- **D — Out in the world:** items that need real movement or time in the world, on either phone: a real drive or walk, battery over an hour, a locked phone in a pocket, airplane mode on the road, a Bluetooth car, the silent switch, the real camera, the microphone and voice.

Camera, microphone and voice items that work at a desk are in B (Android) and C (iPhone), and that includes the silent switch. D keeps the ones that need a real place, road noise or a car.

## How to read this

- "m5 #12" means the 12th checkbox in `device-checklist-m5.md`, counted from the top. The checklists don't number their items.
- A **bold** reference is counted in that section. A plain reference marked "(counted in A)" is a follow-up: the same item on the other phone, or a step that feeds a check made somewhere else. Each item is counted once (see the coverage table at the end).
- Order: C0 first (accounts and keys; A needs them), then A, then the B and C sittings, then D. Claude rehearses the D drive on the emulator before you go (end of A10). After the trip, there's a short second round (end of B and C, and A12).
- Addresses: the phones and the emulator use https://annai.guide, the address you'll travel with. A line that needs a change on the server side uses `<your annai address>` (the dev server through `tailscale serve`). Each address keeps its own data. The push relay is the default, https://push.annai.guide.
- Erasing: m1 #13 and m9's restore erase the iPhone, and both start with an export. Do them before you plan the real Thanksgiving trip. That's why C13 comes last.
- Moving files between the iPhone and Claude: Save to Files, AirDrop to the Mac, copy into the hand-off folder on the server; Claude runs `adb push`. The other way, Claude leaves the file there and you AirDrop it from the Mac.
- Away from home, Claude can't reach either phone, because wireless debugging stops off your home Wi-Fi. Do D by hand; Claude reads the Trace when you're back (the Android over adb, the iPhone through Web Inspector).
- In the car, set things up while parked. While moving, hands-free only: a passenger does any tapping, or it waits until you park.

## A — Emulator (Claude alone)

Setup: the emulator image has Google Play services, so Chrome installs annai as a real app (share target and push need that). If it can't, the share-to-annai lines (m1 #11, m4 #5, m8 #34) move to B. Claude uses the keys and tokens from C0 and keeps them out of the repo. It makes its test files on the server and pushes them with `adb push` plus a media scan: 12 MP and 48 MP JPEGs, a geotagged JPEG, a HEIC, a menu with small print, a PDF, a .pkpass, an .ics, a few hundred photos. Claude can't hear the emulator or speak to it, so for voice it checks the Trace and the page's audio and speech events; hearing is in B and C. In "How": screen = screenshots; console = DevTools on the page; storage = DevTools IndexedDB and `navigator.storage`; adb = the command named. "Then B" or "Then C" means a follow-up on a real phone.

### A1. Install, storage, offline

- [ ] **m1 #1**: In a Chrome tab, the "annai isn't installed yet" card shows; "Show me how" gives the Android steps. How: screen. Then C.
- [ ] **m1 #2**: "Install annai" appears and installs the app. How: screen; `adb shell pm list packages` shows the installed app. Then B.
- [ ] **m1 #4**: In the installed app, Settings → Storage says "Protected from automatic clearing: yes". How: screen; console `navigator.storage.persisted()`. Then C.
- [ ] **m1 #5**: Open the installed app once, then airplane mode, force-quit, reopen: Trips loads with its trips. How: `adb shell cmd connectivity airplane-mode enable`, `am force-stop` on the app; screen. Then C.

### A2. Trips, export and import

- [ ] **m1 #6**: A trip with a Japanese name; a note edited twice; restore the first version. How: DevTools `Input.insertText` for the Japanese; screen; storage shows the history.
- [ ] **m1 #7**: Upload a photo from the gallery; it shows on the file screen. How: adb push, the photo picker; screen. iPhone: m1b #2 in C.
- [ ] **m1 #8**: Export everything with a passphrase; "Save file" opens the share sheet; save to Downloads. How: screen; `adb shell ls /sdcard/Download`. iPhone: m1 #13 in C.
- [ ] **m1 #9**: Settings → Erase → type ERASE → Erase now: Trips is empty. How: screen; storage is empty.
- [ ] **m1 #10**: Open the file from "Open a trip someone sent you", passphrase, tick "Replace my profile and memory", Import: everything is back, history too. How: screen; storage compared with a dump taken before the erase.
- [ ] **m1 #11**: Share a `.annai.zip` from the Files app to annai: the import screen opens with it. How: Files app over adb; screen.
- [ ] **m1 #14**: Drop a `.annai.zip` onto annai in a desktop browser: the import screen opens. How: Playwright in desktop Chromium and WebKit (not the emulator), a drop event carrying the file. Then C (a real drag on the Mac).
- [ ] **m1 #15**: A second tab: "annai is open in another tab" → "Use it here"; the first tab says it stopped. How: two Chrome tabs; screen of each. Then C.
- [ ] **m1 #16**: Install `test/fixtures/plugins/hello` zipped; creating `/hello/a.json` in a trip is refused until the plugin is turned off. How: adb push the zip; screen; console.
- [ ] **m1 #17**: An update while the app is open: "An update is ready", no reload by itself, "Restart now" loads the new version. How: on `<your annai address>`, Claude changes a shipped file and runs `npm run stamp`, then puts it back; screen; console shows the new stamp. Then C.

### A3. Photos

- [ ] **m1b #3**: "Take a photo" (the emulator's camera, a made-up 3D room) and "Add photos or files" do what m1b #1 and #2 check, storing `.webp`. How: screen; storage file names and sizes. Then B (real camera).
- [ ] **m1b #5**: A screenshot is stored as WebP or JPEG; its text is readable when zoomed. How: `adb shell screencap` into Pictures/Screenshots; add it; zoom; screen. Then C.
- [ ] **m1b #7**: Tap a photo: full screen; pinch, drag, double-tap in and back out; Close returns to its page. How: DevTools two-finger touch events, `adb shell input` swipe and double tap; screen. Then C.
- [ ] **m1b #8**: "Where it was taken" opens OpenStreetMap at the right place. How: a geotagged JPEG; the link's lat/lon against the EXIF.
- [ ] **m1b #10**: The iPhone's Keep-originals trip, exported as a Share, imports here as JPEG or WebP and shows. How: the file from the hand-off folder (C4); screen; storage type.
- [ ] **m1b #11**: The same trip exported as a Backup imports here as HEIC, and its page says this browser can't show it. How: as above.
- [ ] **m1b #12**: A Share export with "Include where photos were taken" off, imported after an erase: the photos show, with no "Where it was taken". How: a geotagged JPEG; screen; Claude also unzips the export on the server and checks that no GPS is left in the EXIF or the metadata.
- [ ] **m1b #13**: The same with the box ticked: the location is there. How: as above.

### A4. Removing trips

- [ ] **m1c #1**: Updating a phone that already has photo trips: the first start indexes once (time it), "Using X" stays the same, every photo opens. How: Claude serves a build from before milestone 1c from a git worktree, fills it with photo trips, switches to the current build; console timing; screen.
- [ ] **m1c #2**: A trip with 30 photos: its card says "not backed up". How: adb push 30 photos; screen.
- [ ] **m1c #3**: Remove trip: the first question names the trip; Cancel keeps it, and so does Back. How: screen; `adb shell input keyevent BACK`.
- [ ] **m1c #4**: Remove trip → Remove: "Not backed up" appears; Cancel keeps the trip. How: screen.
- [ ] **m1c #5**: Export trip → Backup → Build file → Save file: the card says "backed up just now". How: screen. Then C.
- [ ] **m1c #6**: A Share export doesn't count: the card still says when the last Backup was. How: screen.
- [ ] **m1c #7**: Add a note: "changed since". Archive and unarchive a backed-up, unchanged trip: the card doesn't change. How: screen.
- [ ] **m1c #8, #9, #10, #12**: Note "Using X of about Y"; back up the 30-photo trip and remove it: only the first question, "Removed <trip>. N MB freed.", card gone; Settings drops by about N MB (or after a full restart). This is milestone 1c's finish line. How: screen; console `navigator.storage.estimate()` before and after. Then C.
- [ ] **m1c #11**: Import the Backup: the trip is back with all 30 photos. How: screen; storage count.

### A5. Models

- [ ] **m2a #4**: OpenRouter endpoint → Test: access and the key get ✓; if a free model fails tool calls or photos, the test says so in plain words. How: screen.
- [ ] **m2a #5**: Anthropic endpoint with a key → Test passes; Test reasoning levels lists each level with ✓ or ✗. How: screen.
- [ ] **m2a #6**: The reply streams in; the line under it gives the model, the tokens and the cost. How: screenshots in a row; Trace. Then C.
- [ ] **m2a #7, #10**: A model with a wrong key first in the main role: the next one answers, "after 1 failed attempt (…: key rejected)". Finish line: plain text works with fallback across two providers, and every request is in the Trace. How: screen; Trace.
- [ ] **m2a #8**: Airplane mode in the middle of a reply: what was said stays; with no connection, the talk says no model answered (couldn't connect). How: adb airplane mode during the stream; screen. Then C.
- [ ] **m2a #9**: Trace: model.turn and net.request entries; "Show what was stored" shows no key. How: screen; Claude also searches all of IndexedDB and a Trace export for each key.

### A6. Shiori

- [ ] **m2b #1**: The dock (camera · Shiori · type) is at the bottom of every screen, clear of the gesture bar and the keyboard. How: screen on each screen, with the keyboard up. Then C.
- [ ] **m2b #2**: Type "What's near McWay Falls?", Send: the Conversation opens, she thinks (looks up and away, the dock says Thinking), and answers in a bubble labeled SHIORI. How: screen.
- [ ] **m2b #3**: Tap Shiori while she thinks: she stops; the dock says "Tap to talk". How: screen.
- [ ] **m2b #4**: A question she has to ask back ("Book something for dinner?") shows buttons; a tap or a typed answer and she goes on. How: screen.
- [ ] **m2b #5**: A second message while she thinks is taken into the same turn. How: screen; Trace.
- [ ] **m2b #6, #21**: Close annai while she thinks, open it again: she answers anyway. Finish line: a text conversation with tools works with fallback across two providers, survives a reload mid-turn, and the Trace shows every request and everything read. How: `am force-stop` mid-turn; screen; Trace. Then C.
- [ ] **m2b #7**: The dock's camera takes a photo into the open trip; Shiori wakes to look at it. How: emulator camera; screen; Trace.
- [ ] **m2b #8**: Reduce motion: no blinks, glances or transitions; she still changes how she looks. How: Android's Remove animations (or DevTools media emulation); screenshots over a minute.
- [ ] **m2b #9**: Dark mode: her eyes and hairpin read well. How: `adb shell cmd uimode night yes`; screen.
- [ ] **m2b #10**: Airplane mode with annai open: the dock says "Offline · reminders still work". How: adb airplane mode; screen. Then C.
- [ ] **m2b #11**: "What's the weather at McWay Falls on Thursday?": she uses weather; the answer has the local time zone. How: Trace → Tools; screen.
- [ ] **m2b #12**: "What's near us?" at a real place: answers from OpenStreetMap or Wikipedia. How: `adb emu geo fix` at the place; Trace → Tools.
- [ ] **m2b #13**: "Read https://www.nepenthe.com/": fetch reads it, directly or through Jina Reader. With no Jina key it says to add one (the emulator's traffic leaves from your home connection); with the key in Settings → Tools, it works. How: screen; Trace → Web.
- [ ] **m2b #14**: Web search: with Anthropic or OpenRouter as main, her own search answers with sources; with search via Jina and a key, web_search answers. How: Trace → Tools.
- [ ] **m2b #15**: Fetch switched off: she says she can't read pages, or uses her model's own fetch if "fetch via" is set to it. How: screen; Trace.
- [ ] **m2b #16**: "Remember …": it lands in /me/memory.md. How: screen; storage.
- [ ] **m2b #17**: "Shorter, please": a card says she adjusted her personality; Undo puts it back. How: screen; storage.
- [ ] **m2b #18**: Steps per wake 2 and a long request: her turn ends with a card that says why. How: screen.
- [ ] **m2b #19**: Trace → Conversation shows each wake's cost; Trace → Tools shows each tool call and what it read; no key anywhere. How: screen; key search.
- [ ] **m2b #20**: A long conversation (or a low housekeeping threshold): "Earlier conversation summarized", and she keeps the gist. How: screen.

### A7. Photos to Shiori

- [ ] **m2c #2**: Trace → Tools: her read of a 12 MP photo says both sizes ("4032×3024, sent as 2000×1500"). How: a pushed 12 MP JPEG; Trace.
- [ ] **m2c #3**: "What does the small print say?": she reads a region; the Trace shows the part she cut. How: the pushed menu JPEG; Trace.
- [ ] **m2c #4**: A photo from the trip's files, zoomed to a part, "Show Shiori this part": she answers about that part. How: touch zoom; screen.
- [ ] **m2c #5**: With the Anthropic endpoint: Trace → Web has one upload per photo (kind upload); later turns don't upload it again. How: Trace.
- [ ] **m2c #6**: Test on the Anthropic model says "Photo uploads work"; with uploads off on the endpoint, photos go in each request. How: screen; Trace → Web.
- [ ] **m2c #7**: Photos for Shiori at 1000 px: smaller photos; a closer look still shows detail. How: sizes in the Trace.
- [ ] **m2c #8, #12**: A model with its image limit set high, sent a large photo: it's resent smaller by itself, and the model's page keeps the new limit. Milestone 2's finish line: text and photos with tools and fallback, all in the Trace, and a refused photo repaired with no help. How: Trace; screen.
- [ ] **m2c #9**: "Largest photo sent" at 5 MB, a large photo to Claude: if the limit is counted on the encoded text, the repair shrinks it once and it goes through. How: Trace.
- [ ] **m2c #10**: Reload while she thinks about a photo: after the reload she answers it. How: DevTools reload; Trace. Then C.
- [ ] **m2c #11**: Remove a trip full of photos: the space comes back at once (Settings → Storage); another trip's photos are untouched. How: `navigator.storage.estimate()`; screen. Then C.

### A8. Voice: what Claude can see

- [ ] **m3 #1**: Open annai fresh: nothing plays before a tap; after one tap, Test the voice plays. How: console: the audio context is suspended before the tap and running after; the sample plays to its end. Then B (you hear it).
- [ ] **m3 #5**: A voice with a wrong key first in Speech out: the next voice plays the whole sample; the Trace shows the failed request without the key. How: Trace; console audio events; key search.
- [ ] **m3 #7**: Microphone denied (Chrome's site setting): the message says what happened and gives the Android steps. How: screen. Then C.
- [ ] **m3 #15**: A text-only main model and only "Send audio to the model" in Speech in: tapping Shiori shows a card that says what to add. How: screen.
- [ ] **m3 #22**: Fresh install, microphone not allowed yet: the chip says "Voice auto · off"; On, then Auto: "Voice on · your last choice". How: clear site data; screen. Then C.
- [ ] **m3 #30**: While she speaks, her words show in a bubble above the dock (no Captions chip; Settings → Voice → Show what she says). How: screen.

### A9. Bookings and planning

- [ ] **m4 #5**: Share a .pkpass or a PDF from the Files app to annai: "Add to Thanksgiving" adds it, and Shiori is woken once. How: adb push; Files share; Trace.
- [ ] **m4 #6**: Two confirmations with the same file name are both kept ("confirmation (2).pdf"). How: screen; storage.
- [ ] **m4 #7**: "Plan the trip": she goes in order (getting there, getting around, where to stay, the rest) and hands over search links and directions as cards; the links open the right sites, filled in. How: screen; each link's URL. Then C.
- [ ] **m4 #8**: The Plan: a tab per day, flights and check-ins as ● fixed, the rest as ○ flexible, times in each place's own zone, legs with Directions into Google Maps. How: screen; the Directions link. Then C (Apple Maps).
- [ ] **m4 #9**: An unconfirmed booking shows "Check this"; on the Booking screen the original opens and "Looks right" confirms it; the chip goes. How: screen. Then C.
- [ ] **m4 #10**: An .ics of the trip's dates adds plan items once; adding it again changes nothing. How: adb push; screen; storage.
- [ ] **m4 #12**: Nothing on the Plan or Booking screens scrolls sideways; every button is easy to hit. How: console: `scrollWidth` against `clientWidth` on each screen, and button sizes. Then C.

### A10. Live mode

- [ ] **m5 #1**: GPS chip → on: Android asks for location once (allow "While using the app"); the chip says "GPS on · finding you", then "GPS on · stopped". How: `adb emu geo fix`; screen. Then C.
- [ ] **m5 #2**: Shiori is woken once ("The user turned live mode on"); Trace → Tools: watch_set. How: Trace.
- [ ] **m5 #3**: Now shows "At …" or "Near …" a plan stop, the sun chips, what's next and the latest card. How: geo fix at a stop; screen.
- [ ] **m5 #4**: Close annai fully and open it again: live mode is still on; nothing is asked again. How: `am force-stop`; screen. Then C.
- [ ] **m5 #5**: Location refused: a card "annai can't see where you are" with the right Android steps. How: deny it; screen. Then C (the iPhone has two paths to try).
- [ ] **m5 #6**: Live → Where are you? lists the plan's places; choosing one makes Now say "At …". How: screen.
- [ ] **m5 #7**: Location allowed again, live mode off and on: the GPS works. How: screen. Then C.
- [ ] **m5 #19, #20, #21**: Airplane mode with voice on, and a reminder comes due: the fallback shows as a card and is spoken by the phone's own voice; the dock says "Offline · reminders still work"; back online, Shiori hears what came while offline, once. How: a faked route; adb airplane mode; console speech events; Trace → Live and Conversation. Then C.
- [ ] **m5 #22**: Offline pack: "Download (about … KB)" before anything; on Wi-Fi it shows each part, then "Downloaded just now · … places, … Wikipedia summaries, … Wikivoyage guides" and the guides' names; Stop and "Download the rest" work. How: screen (it can take minutes).
- [ ] **m5 #23**: Trace → Web: requests only to overpass-api.de, en.wikipedia.org and en.wikivoyage.org, one at a time, about a second apart, and a "pack.download" line. How: Trace.
- [ ] **m5 #24**: On Wi-Fi with the trip open, Shiori adds a stop: within a few minutes the panel says "Downloaded just now" again with no tap ("by itself on Wi-Fi"). How: screen; Trace → Web.
- [ ] **m5 #26**: Airplane mode at a plan stop: "What's around here?" and "Tell me about Big Sur" are answered from the pack, and she says so; Now says "Near …" a place the pack names. How: geo fix; adb airplane mode; screen.
- [ ] **m5 #27**: Still offline, a place far off the plan: she says OpenStreetMap and Wikipedia didn't answer. How: screen.
- [ ] **m5 #31**: Export the rehearsal trip as a Backup and remove it: the toast says how much was freed; the trip is gone; live mode on again fires none of its watches. How: screen; Trace → Live.
- [ ] Rehearsal of the D drive, m5 #8–#13, #17, #18, #30 (counted in D): before you drive, Claude plays a faked drive once a second with `adb emu geo fix` (real speeds, two minutes at a plan stop, 20 minutes off the plan, a 15-minute locked stretch) and fixes what breaks.

### A11. Push reminders

- [ ] **m6 #2**: Installed app, Settings → Notifications, default relay → Save address → Turn on notifications: asked once; allow. How: screen. Then C.
- [ ] **m6 #3**: Within seconds: "Notifications are on. Reminders come like this while annai is closed."; the screen says "On · 0 reminders waiting at the relay." How: `adb shell dumpsys notification`; screen. Then C.
- [ ] **m6 #4**: Refused once (off, on, Don't allow): the screen says where to allow it, in Android's words. How: screen.
- [ ] **m6 #5**: Send a test notification and lock at once: it's on the lock screen about 15 seconds after the tap. How: `adb shell input keyevent KEYCODE_SLEEP`; dumpsys times; wake and screen. Then C.
- [ ] **m6 #6, #7, #8**: "Remind me in 5 minutes to check the parking meter": "1 reminder waiting"; annai closed fully, phone locked; it arrives about 30 seconds after the time, with the trip's name and her words. How: `am force-stop`; lock; dumpsys post time against the due time. Then D3 (iPhone).
- [ ] **m6 #9**: Tap it: annai opens and she catches up; Trace → Notifications has push.shown and push.opened; the catch-up wake says "The user opened the reminder …". How: tap on the lock screen over adb; Trace. Then D3.
- [ ] **m6 #10, #19**: The same with annai in the background (another app open), not closed: same notification, same catch-up. How: `am start` another app; as above. Then D3.
- [ ] **m6 #11**: A fixed plan item an hour ahead with no place, annai closed: "In 15 min: …" arrives 15 minutes before it. How: dumpsys times. Then D3.
- [ ] **m6 #12**: A reminder in 10 minutes that Shiori cancels: nothing in 12 minutes. How: dumpsys.
- [ ] **m6 #13**: A plan item moved later: its "coming up" arrives at the new time, not the old. How: dumpsys.
- [ ] **m6 #14**: A trip with a reminder waiting, removed: nothing arrives for it. How: dumpsys.
- [ ] **m6 #15**: Notifications off: "0 reminders waiting", and nothing arrives. How: screen; dumpsys.
- [ ] **m6 #16**: annai open on screen (Now, or live mode on) when a reminder comes due: Shiori says it, and no notification follows within a minute. How: Trace; dumpsys. Then C.
- [ ] **m6 #17**: The same in Driving with the screen kept on. How: a faked route; as above. Then D2.
- [ ] **m6 #18**: What Android shows: title, text and icon; on the lock screen or not; a tap opens annai, not Chrome first. How: screenshots of the shade and the lock screen. Then B.
- [ ] **m6 #23**: Trace, System · This device: each relay call is a web request ("push relay", a URL and a status); no token or key in any of them. How: Trace; key search.

### A12. Simulation, stamps, recap, replay

These use the Big Sur sample now. After Nov 29, Claude runs them again with the real Thanksgiving trip, restored onto the emulator from the GitHub backup (m9).

- [ ] **m7 #1**: Settings → Developer → Simulate a trip → Big Sur sample at 600×: the chip says "Simulation · …"; Now and Driving follow the day (Now hands over to Driving when the drive starts); Shiori wakes (Trace → Live). How: screen; Trace.
- [ ] **m7 #2**: Pause and Resume from the chip; change the speed; Stop: the chip says "GPS off", and live mode is as it was. How: screen.
- [ ] **m7 #3**: As fast as it can go: it ends in about a minute; Replay and Recap from the screen; remove that trip. How: screen; timing.
- [ ] **m7 #4**: A real reminder ("Friday at 8 to pack the camera batteries") doesn't fire during a fast simulation and is still there after (nothing new in Trace → Live); it fires on Friday at 8. How: Trace; Claude checks on Friday.
- [ ] **m7 #5**: Reload in the middle of a simulation: annai opens the trip that was open before; with live mode on, that trip's Trace → Location gets the new points and the simulation's trip gets none. How: geo fix; reload; point counts in storage.
- [ ] **m7 #6**: "The recorded track of a trip on this device": the replay looks like the drive did. How: the rehearsal trip; after D2, also the real drive's trip restored from GitHub; maps side by side.
- [ ] **m7 #7**: The trip's card: "N stamps", the first two marks and "+N"; they read as station stamps, a little crooked, in light and dark mode. How: screen; `cmd uimode night yes`.
- [ ] **m7 #9**: The card's spoken name: "N stamps:" and the places' names. How: DevTools accessibility tree. Then C (VoiceOver).
- [ ] **m7 #10**: Recap → Write the recap: about a minute; a section per day, in order, naming the places. How: screen; timing. Then B and C (time it on each phone after the trip).
- [ ] **m7 #11**: "What goes to …" matches the recap call in Trace → Models; no GPS track in it. How: Trace.
- [ ] **m7 #12**: Write it again: the new one replaces it; Edit → the file's history has the old one. How: screen; storage.
- [ ] **m7 #13**: "Hear Shiori tell it" with voice Off: a few sentences at a time; the microphone never opens (the dock never says Listening; any question comes as buttons); a tap stops her. With voice On she listens after each part. How: speak calls in the Trace; console: no microphone request while voice is Off; screen. Then C (quiet room) and D4 (car).
- [ ] **m7 #15**: The map: the road, north up, dashed where the phone was locked or you flew; stops as rings, stamps as vermilion rings. How: screen (the rehearsal has a locked stretch).
- [ ] **m7 #16**: Play at each speed: the dot follows the road and the vermilion line grows; "At this moment" says where, the stamps so far, the latest card; it stops at the end; Play again starts over. How: screen.
- [ ] **m7 #17**: Drag the scrubber: the dot and the panel follow; it doesn't fight the finger while playing. How: `adb shell input swipe` (a real touch on the emulator); screen. Then C.
- [ ] **m7 #18**: Tap timeline entries: playback jumps there; a photo entry shows the photo; Open full size opens the viewer, with pinch zoom. How: screen; touch events. Then C.
- [ ] **m7 #19**: Leave the replay while it plays and come back: nothing kept running. How: DevTools performance trace: no frames or timers while away.
- [ ] **m7 #20**: The map is announced as "The route: … km on the road, from … to …"; the scrubber says the time and the place; the timeline reads in order; each new place is announced once while it plays. How: accessibility tree; a recorder on the live region. Then C (VoiceOver).
- [ ] **m7 #21**: The real trip's Backup from the iPhone, imported here: the recap, the replay and the stamps are the same. How: the hand-off file (C14); screens side by side.

### A13. Extensions

Claude starts the stand-in: `node scripts/mcp-stand-in.mjs --port 8798 --token <a long random token> --files test/fixtures/extensions`, then `tailscale serve --bg --https=8799 http://127.0.0.1:8798`. `<stand-in>` is the same host as `<your annai address>`, on port 8799.

- [ ] **m8 #1, #2**: Settings → Plugins → Address `<stand-in>/files/tide-pools/SKILL.md` → Get it: "Install tide-pools?", "A skill · version 1.2 · by Example Trails", "From …/files/tide-pools/SKILL.md", what it brings, and the note that annai never runs anything in a skill; no full-access sentence. How: screen.
- [ ] **m8 #3**: Install: Settings → Plugins lists "tide-pools 1.2", Skill, From …. How: screen.
- [ ] **m8 #4**: "Are the tide pools safe to visit now?": Trace → Tools has `skill` with `tide-pools`, then likely `references/safety.md`. How: Trace.
- [ ] **m8 #5**: Remove (Remove, then tap again): gone from Plugins; in a new conversation no `skill` call for it, and its name isn't in the next request (Trace → Models). How: Trace.
- [ ] **m8 #6, #7, #8**: Tools → MCP servers: `trail`, `<stand-in>/mcp`, Bearer token → Add: "Checking…", then the card ("A bearer token, kept on this device", six `mcp_trail_*` tools); the token field is empty and the token is nowhere on screen; Settings → Tools has a group "MCP: trail" with a switch each. How: screen.
- [ ] **m8 #9**: "Use the trail echo tool to say 'low tide at 5:40'": `mcp_trail_echo` and its result. How: Trace → Tools.
- [ ] **m8 #10**: "Ask the trail server who you are": `Bearer «key»`, never the token. How: screen.
- [ ] **m8 #11**: "Show me the trail map": a small image; the result holds an image. How: screen; Trace → Tools.
- [ ] **m8 #12**: Trace → Web: each request to `…/mcp` (200 or 202) under the tool's name; no token in them. How: Trace; key search in storage and a Trace export.
- [ ] **m8 #13**: `mcp_trail_echo` switched off: she can't, or finds another way; the request has no `mcp_trail_echo`. How: Trace → Models.
- [ ] **m8 #14**: A second server `wrong`, same address, wrong token: "refused annai's key", and nothing is added. How: screen.
- [ ] **m8 #15**: `zap` at `<stand-in>/api/s/abc123def456ghi789/mcp`: its card shows `…/api/s/«key»/mcp`; its echo works; Trace → Web shows `«key»`, never `abc123def456ghi789`; remove `zap`. How: screen; Trace.
- [ ] **m8 #16**: An address with `name:password@` before the host is refused, and points to the Token or Headers field. How: screen.
- [ ] **m8 #17**: Stand-in stopped: "the server can't be reached"; started again: the next call works (a new session). How: Claude stops and starts it; screen.
- [ ] **m8 #18**: Remove `trail`: its tools leave Settings → Tools; the stand-in's log shows a DELETE. How: screen; log.
- [ ] **m8 #19, #20**: Address `<stand-in>/files/tides/annai-plugin.json` → Get it: "Install Tides?", "A plugin · version 1.0.0 · by annai tests", the homepage link, "Code that runs in annai", and on its own "This plugin gets full access to your trips and API keys."; Cancel installs nothing. How: screen.
- [ ] **m8 #21**: Get it again → Install: the dock's chip row shows "Tide 1.0.0". How: screen.
- [ ] **m8 #22**: Today's tides: "low 05:40, high 11:52" (`tide_times`). How: Trace → Tools.
- [ ] **m8 #23**: Close annai fully and reopen: the chip is back, and the tool still works. How: `am force-stop`; screen.
- [ ] **m8 #24**: Tides's own page (tap its name in Plugins): its tool, its source, Turn off, Remove. How: screen.
- [ ] **m8 #25**: Remove it: the chip goes, the tool leaves Settings → Tools; a restart is asked only if you install it again in the same session. How: screen.
- [ ] **m8 #27, #28, #29, #30**: With Tides installed from the address and annai closed, Claude bumps `annai-plugin.json` and `lib.js` to 1.1.0; on opening, "Plugin updates are ready: Tides 1.0.0 → 1.1.0", the chip still says 1.0.0, Plugins has "Update to 1.1.0"; Update → "Restart annai to use the new versions" → the chip says 1.1.0; then `git checkout test/fixtures/extensions/tides`. How: screen.
- [ ] **m8 #31**: On an iPhone SE-sized screen, the dock's chips wrap and nothing overlaps. How: `adb shell wm size 640x1136` and `wm density 320`, then `wm size reset`; screen.
- [ ] **m8 #32**: The install screen with the keyboard up after typing an address: Install and Cancel can be reached. How: screen. Then C.
- [ ] **m8 #33**: `test/fixtures/extensions/trail-ui` as a zip: its dock action is big enough, and a tap works. How: adb tap (a touch, not a mouse); size from DevTools. Then C.
- [ ] **m8 #34**: Share a plugin's `.zip` to annai from the Files app: note what happens (the import screen) and any words that would confuse someone. How: screen.
- [ ] **m8 #35**: Afterwards: `tailscale serve --https=8799 off`, and the stand-in stopped. How: Claude does it.

### A14. Backups

The emulator goes first, and its commits say "annai backup from Android phone". The iPhone in C is the second phone.

- [ ] **m9 #3, #4**: Automatic backups → Add a place → GitHub → Add (installs the GitHub plugin); `you/annai-backup` and the emulator's token → Save and test: "Works: annai can reach you/annai-backup, a private repository." How: screen.
- [ ] **m9 #5, #6**: Within minutes, on Wi-Fi with annai open: "Last backup just now"; a commit "annai backup from Android phone" with `annai-archive.json`, `me`, `trips`, `system`; a trip's notes readable there; each trip card says "backed up … ago". How: screen; `gh api` on the repo. Then C.
- [ ] **m9 #7**: A new note, then an hour with annai open: a new commit whose changed files are the note, the logs and `annai-archive.json`; no photo sent again. How: the commit's diff through `gh`.
- [ ] **m9 #9**: "Upload without asking up to, MB" shows 25; at 0 a change waits with the card; empty (no limit) it goes without asking; back to 25. How: DevTools network emulation with connection type "other", so Chrome stops saying Wi-Fi (annai applies the limit only then).
- [ ] **m9 #10**: Trace → Web: each GitHub request is a line `plugin:storage-github · …`; Kind Backups: a line per backup; Copy diagnostics has no token in it. How: Trace; clipboard through the console; key search.
- [ ] **m9 #12**: Wi-Fi off (mobile data on) and a change: no new commit; Wi-Fi on: one within a few minutes. How: `adb shell svc wifi disable` / `enable`; `gh`.
- [ ] **m9 #13**: "Also over mobile data" on: changes are backed up on mobile data too. How: as above.
- [ ] **m9 #14**: A change: a commit "annai backup from Android phone". How: `gh`. Claude does this again during C12, for m9 #15 and #17.
- [ ] **m9 #18, #19, #20, #21, #22**: Export everything first; Erase; GitHub → repo and token → Save and test → "A backup is already here" → Import it as a copy ("Replace my profile and memory" and "Replace my settings" already ticked) → Import: every trip is back (notes with history, photos, plan, bookings), and the models are back without their keys; Restart as asked: the next commit's parent is the one restored; Show the backups here → an older one → Open: the preview shows that day's trips. How: screen; storage compared with a dump from before; commit parents through `gh`. Then C.
- [ ] **m9 #24**: S3-compatible storage → Add: the "Browser access" panel shows the CORS rules, with annai's address as the origin. You paste them into the R2 bucket's CORS settings when Claude asks (a minute at the Mac). How: screen.
- [ ] **m9 #25, #26**: Address (R2: `https://<account id>.r2.cloudflarestorage.com`, region `auto`), bucket, key ID, secret, "Encrypt backups with a passphrase" typed twice → Save and test: before the rules are pasted, it says the bucket doesn't allow browser access yet; after, "Works: …". How: screen.
- [ ] **m9 #27**: Within minutes a file `annai/annai-backup-…` named for this phone; four backups later (a change each time), only the last 3 of this phone's are left. How: a listing over the S3 API. Then C.
- [ ] **m9 #28**: Restore onto the wiped emulator, as for GitHub: it asks for the passphrase, and everything comes back. How: screen; storage comparison.
- [ ] **m9 #29, #30, #31**: WebDAV: Claude runs Apache with mod_dav and mod_headers (the panel's headers; OPTIONS answered without a password) behind `tailscale serve`; the folder's address, user name, password → Save and test: "Works: annai made the folder …"; a backup file appears; Show the backups here → Open brings up the import preview. How: screen; the server's folder.
- [ ] **m9 #32**: A public repository: Save and test says it's public, and how to make it private. How: any public repo of yours (fine-grained tokens can read public repos).
- [ ] **m9 #33**: A wrong or expired token: "GitHub didn't accept the access token …", and one card when an automatic backup meets it. How: screen.
- [ ] **m9 #34**: A repository with code in it: "… holds other files (…), so annai won't back up into it." How: the private repo with code from C0.
- [ ] **m9 #35**: Airplane mode: no pile of cards; backups show the last try failed and carry on later by themselves. How: adb airplane mode for an hour; screen.
- [ ] **m9 #36**: A wrong S3 secret: "… didn't accept the access key …"; the wrong region: "… is in the region …; set Region to …". How: screen.
- [ ] **m9 #37**: A wrong WebDAV password: "… didn't accept the user name and password …". How: screen.

## B — Real Android, Claude drives

Your phone stays on home Wi-Fi. Claude taps and types; you speak, listen, hold the phone, and sign in where needed.

### B1. Setup

- [ ] m1 #2 (counted in A): You turn on Developer options → Wireless debugging → Pair device with pairing code and read Claude the code. Claude connects and opens annai.guide: "Install annai" installs it as a real app.
- [ ] **m2a #1**: Settings → Models → Sign in with OpenRouter: OpenRouter opens; you sign in and approve; annai shows "Signed in with OpenRouter", and the main role lists a free model.

### B2. Only a real Android phone

- [ ] **m1b #6**: In Google Photos, two photos → Share → annai: "Add 2 photos" → "Add to <trip>": both are in the trip.
- [ ] m1b #3 (counted in A): "Take a photo" with the real camera, held sideways: stored as `.webp` and shown upright. You hold the phone.
- [ ] m1b #4 (counted in C): Claude pushes a 48 MP photo and adds it: stored at about 16.7 MP, not blank or black.
- [ ] **m4 #4**: Gmail: a confirmation email → Share → annai: it arrives as "shared text.txt"; added to the trip, Shiori writes the booking.
- [ ] **m4 #11**: Add to calendar: Google Calendar imports the file, and the events land at the right local times. The iPhone half is in C13.
- [ ] m6 #18 (counted in A): Claude sends a test notification and screenshots the lock screen and the shade: title, text, icon; a tap opens annai, not Chrome first. Note anything that differs from the emulator.

### B3. Voice: you listen and speak

- [ ] **m3 #3**, with m3 #1 (counted in A): After a fresh start and one tap, Settings → Voice: the list shows this phone's voices; pick one, speed 1.2, Save, Test the voice (Browser voice first in Speech out): you hear that voice, a little faster.
- [ ] **m3 #4**: Add "OpenAI: voice" with your key; Test the voice: you hear Marin. The silent switch half is iPhone only (C8).
- [ ] **m3 #6**: Test the microphone and say "Where should we stop for lunch?": the meter moves while you speak; it reports a few seconds of speech and, with a transcription model, your words.
- [ ] **m3 #9**: Voice On; tap Shiori; "Where should we eat?": Listening, then Hearing you (the glow follows your voice), then Thinking; she answers aloud and listens; you answer; she replies and sleeps (Tap to talk). The microphone dot is off whenever she sleeps.
- [ ] **m3 #10**: Claude taps her while she speaks: she stops at once and listens; what you say next is the answer; in the Trace her speak result says where you stopped her.
- [ ] **m3 #11**: After you answer, add a second thought while she still thinks: her reply covers both.
- [ ] **m3 #12**: With a quick-decision model, while she listens, say something to someone else ("can you pass the water?"): she doesn't answer, goes to sleep, and the conversation shows "Heard, not for Shiori".
- [ ] **m3 #13**: Speech in: Phone dictation first, no transcription model: a spoken exchange works in Chrome. The iPhone half is m3 #28 in C8.
- [ ] **m3 #14**: An audio model (Gemini through OpenRouter) as main and "Send audio to the model" first: a spoken exchange works without a transcription model; your words appear after her reply.
- [ ] **m3 #17**: Settings → Voice → Where your voice goes: note what it says for Phone dictation and the browser voice. In airplane mode, does dictation still write your words, and does the browser voice still speak?
- [ ] **m3 #18**: In airplane mode, the keyboard's microphone key in the message box: does it type your words? Sent, does Shiori get it as a typed message?
- [ ] **m3 #19**: Music playing in a music app, then a spoken exchange (it pauses while she talks): afterwards, does the music come back by itself or stay paused?
- [ ] **m3 #20**: Voice chip on Auto; you connect Bluetooth headphones, and the microphone is allowed once: "Voice on · headphones"; disconnect them: "Voice auto · off".
- [ ] **m3 #25**: annai and Maps in split screen: tap Shiori, talk, and she answers.

### B4. After the trip (Nov 30 or later)

- [ ] **m7 #8**: Claude shows the Thanksgiving trip's stamps; you say which places you expected and didn't get, and any you didn't expect.
- [ ] **m7 #14**: Replay opens within a few seconds with five days of points (Claude times it); a tab per day; the whole trip shows the whole road.
- [ ] m7 #10 (counted in A): Write the recap here; Claude times it.

## C — iPhone in hand

One sitting, in this order. Keep the Mac open with Safari → Develop → your iPhone, so Claude can read the console and storage. Claude has done A first, and keeps the emulator and the Android phone ready for the lines that need them.

### C0. At the Mac, before anything (A needs this)

- [ ] **m9 #1**: On github.com, a new private repository `annai-backup` (a README is fine; nothing else).
- [ ] **m9 #2**: Fine-grained tokens, one per phone: "annai on iPhone" and "annai on Android phone" (the emulator plays the Android phone). Each: Only select repositories → `annai-backup`; Contents: Read and write. The emulator's token also gets one private repository with code in it, for m9 #34. Give Claude the emulator's token.
- [ ] **m9 #23**: An R2 bucket for annai alone, with a token that has only Object Read & Write on that bucket; give Claude the key ID and secret.
- [ ] m2a, m2b, m2c, m3 (setup): give Claude an OpenRouter, an Anthropic, an OpenAI (voice) and a Jina key, with low spending limits, for the emulator.
- [ ] m1 (setup): iPhone Settings → Apps → Safari → Advanced → Web Inspector on.

### C1. In a Safari tab, before installing

- [ ] m1 #1 (counted in A): The "annai isn't installed yet" card shows; "Show me how" gives the iPhone steps.
- [ ] **m6 #1**: Settings → Notifications says notifications work only in the Home Screen app, and how to add it.
- [ ] **m2a #3**: Settings → Models → Sign in with OpenRouter: the sign-in comes back to annai by itself.
- [ ] m1 #15 (counted in A): annai in a second Safari tab: "annai is open in another tab" → "Use it here"; the first tab says it stopped.

### C2. Install

- [ ] **m1 #3**: Share → Add to Home Screen; open it from the Home Screen: the warning is gone.
- [ ] m1 #4 (counted in A): Settings → Storage: "Protected from automatic clearing: yes" (tap "Protect my data" if not).
- [ ] m3 #22 (counted in A): Before the microphone is allowed, the voice chip says "Voice auto · off"; On, then Auto: "Voice on · your last choice".

### C3. Models

- [ ] **m2a #2**: Sign in with OpenRouter: annai asks you to paste the code OpenRouter shows; copy it, paste it, Connect: signed in.
- [ ] m2a #6 (counted in A): Add your Anthropic key too (photos upload there). Talk to Shiori: the reply streams in, and the line under it gives model, tokens and cost.

### C4. Photos and files

- [ ] **m1b #1**: In a trip, "Take a photo" holding the phone sideways: listed as `/files/<date>-<time>.jpg`, shown upright; its page says when it was taken and, if the Camera may use your location, where.
- [ ] **m1b #2**, with m1 #7 (counted in A): "Add photos or files", three 12 MP HEIC photos from the library: "Adding 2 of 3…"; each is stored as `.jpg`, and each page says 4032 × 3024 (or 3024 × 4032).
- [ ] **m1b #4**: A 24 or 48 MP photo: stored at about 16.7 MP, neither blank nor black (blank means `MAX_CANVAS_PIXELS` is too high for this phone). If your iPhone doesn't shoot 24 or 48 MP, use the 48 MP JPEG Claude leaves in the hand-off folder.
- [ ] m1b #5 (counted in A): A screenshot is stored as JPEG, and its text still reads when you zoom in.
- [ ] m1b #7 (counted in A): Tap a photo: pinch, drag, double-tap in and back out with your fingers; Close returns to its page.
- [ ] **m1b #9**: Settings → Photos → Keep originals → Save photo settings; add a HEIC photo: stored as `.heic`, shows, and its page says "Stored as taken".
- [ ] m1b #10, #11 (counted in A): Export that trip as a Share, and again as a Backup; hand both files to Claude.
- [ ] **m1b #14**: Milestone 1b's finish line: export the trip with the three 12 MP photos as a Backup and hand it to Claude (it checks they show on the emulator); import the Backup Claude leaves you from the emulator: its Android photo shows here.

### C5. Removing trips

- [ ] m1c #5 (counted in A): Export trip → Backup → Build file → Save file → Save to Files: on Trips, the card says "backed up just now".
- [ ] m1c #10, #12, m2c #11 (counted in A): Note "Using X" in Settings; back up and remove a trip with about 30 photos; note the usage at once and again after closing annai fully. Write down what you saw (Safari may hand space back later). Another trip's photos still open.

### C6. Export, erase, import

- [ ] **m1 #13**, with m1 #8, #9, #10 (counted in A): On the oldest iPhone you'll travel with: a trip with a few hundred photos; Export everything with a passphrase → Save to Files; Settings → Erase → ERASE → Erase now; Trips → "Open a trip someone sent you" → the file → passphrase → tick "Replace my profile and memory" → Import. Both ways finish without the page reloading or going blank, and everything is back, history too.
- [ ] **m1 #12**: Message or email a trip export to the Android phone; Claude imports it there over adb, and it's all there.
- [ ] m1 #5 (counted in A): Airplane mode, swipe annai away, reopen: Trips loads, with its trips.
- [ ] m1 #14 (counted in A): On the Mac, drag a `.annai.zip` onto annai in Safari: the import screen opens with it.
- [ ] m1 #17 (counted in A): With the app open, Claude puts out a release (you OK it first): "An update is ready" shows; it doesn't reload by itself; "Restart now" loads the new version.

### C7. Shiori

- [ ] m2b #1 (counted in A): The dock stays clear of the Home indicator and of the keyboard, on every screen.
- [ ] m2b #6, m2c #10 (counted in A): Swipe annai away while she thinks, reopen: she answers anyway. Then reload from Web Inspector while she thinks about a photo: she answers after the reload.
- [ ] m2a #8, m2b #10 (counted in A): Airplane mode during a reply: her words so far stay; the dock says "Offline · reminders still work"; a new message says no model answered (couldn't connect).

### C8. Voice

- [ ] **m3 #2**: Close annai fully, open it from the Home Screen, tap Shiori once with a finger and ask something: does her voice play? (A tap before annai has started is fine: the next tap tries again.)
- [ ] **m3 #27**: Close fully and open from the Home Screen; without tapping Shiori, send a message with the keyboard's return key: does she speak, or does a card ask for a tap?
- [ ] m3 #3 (counted in B): Settings → Voice: the list shows the iPhone's voices; pick one, speed 1.2, Save, Test the voice: you hear that voice, a little faster.
- [ ] **m3 #16**, with m3 #4 (counted in B): Add "OpenAI: voice"; Test the voice: Marin. Silent switch on: test again, then a spoken exchange: is she heard?
- [ ] m3 #6, #7 (counted in B and A): Test the microphone (the meter moves, a few seconds, your words); then deny the microphone (or turn it off in Settings): the message says what happened and gives the iPhone steps.
- [ ] m3 #9, #10, #11, #12 (counted in B): A spoken exchange (Listening → Hearing you → Thinking → answers aloud → listens → sleeps; the orange microphone dot is off whenever she sleeps); tap her while she speaks; add a thought while she thinks; talk to someone else: "Heard, not for Shiori".
- [ ] **m3 #28**, with m3 #13 (counted in B): Speech in: Phone dictation first, no transcription model. In a Safari tab and in the installed app, does dictation hear you, and does a spoken exchange work? If it fails, does recording take over (with a transcription model second)?
- [ ] m3 #14 (counted in B): "Send audio to the model" with the audio model: a spoken exchange works; your words appear after her reply.
- [ ] m3 #17, #18 (counted in B): Where your voice goes: note what it says. In airplane mode: does dictation still write your words; does the browser voice still speak; does the keyboard's dictation key type, and does Shiori get it as typed?
- [ ] m3 #19 (counted in B): Music playing, then a spoken exchange: afterwards, does the music come back by itself?
- [ ] m3 #20 (counted in B): AirPods, chip on Auto, microphone allowed once: "Voice on · headphones"; disconnect: "Voice auto · off".

### C9. Live mode

- [ ] m5 (setup): A test trip with three stops near home: one fixed, two flexible, with places.
- [ ] m5 #1, #4 (counted in A): GPS chip → on: the iPhone asks for location once (allow While Using); "GPS on · finding you", then "GPS on · stopped"; close fully and reopen: still on, nothing asked again.
- [ ] m5 #5, #7 (counted in A): Refuse location: the card's iPhone steps. Try it in a Safari tab (aA → Website Settings → Location) and in the Home Screen app (Location Services → Safari Websites, and Safari's own Location setting): note whether each path leads to the setting that works, and what it's called on your iOS version. Allow again, live off and on: the GPS works.
- [ ] **m5 #25**: Download the offline pack: the panel says Safari doesn't tell annai when it's on Wi-Fi; after a plan change it offers "Update (about … KB)".
- [ ] m5 #19, #20, #21 (counted in A): Airplane mode, voice on, a reminder in 2 minutes with annai open: the iPhone's own voice says it, and a card shows it; back online, Shiori hears it once.

### C10. Notifications

- [ ] m6 #2, #3 (counted in A): Settings → Notifications (default relay) → Turn on notifications; allow: within seconds, "Notifications are on…"; the screen says "On · 0 reminders waiting at the relay."
- [ ] m6 #5 (counted in A): Send a test notification and lock at once: it's on the lock screen about 15 seconds after the tap.
- [ ] m6 #16 (counted in A): annai open on Now, a reminder in 2 minutes: Shiori says it, and no notification follows within a minute.
- [ ] **m6 #20**: A Focus on: a test notification follows the Focus settings (held or allowed).
- [ ] **m6 #21**: Restart the iPhone: a test notification still arrives without turning them on again. If not, note it: annai should show a card saying how to turn them back on.

The rest of m6 on the iPhone happens in D3.

### C11. Extensions

Tailscale on, so the iPhone can reach `<stand-in>`; Claude runs the stand-in and gives you the token.

- [ ] m8 #1, #3, #4, #6, #7, #9, #11, #19, #21, #22, #23 (counted in A): Install the tide-pools skill and ask about tide pools; add the `trail` MCP server with the token and ask for the echo and the map; install Tides from its address and ask for today's tides; close annai fully and reopen: the chip and the tool are back.
- [ ] m8 #32 (counted in A): On the install screen with the keyboard up after typing an address, Install and Cancel can be reached.
- [ ] **m8 #26**, with m8 #33 (counted in A): Remove Tides. Claude zips `test/fixtures/extensions/tides/` and `trail-ui`; AirDrop them from the Mac to Files; Settings → Plugins → Install from a file: the same install screen as from the address. Then trail-ui's dock action: big enough, and a finger tap works.

### C12. Backups

Claude has backed up the emulator to `annai-backup` (A14).

- [ ] **m9 #11**, with m9 #3, #4 (counted in A): Automatic backups → GitHub → Add; `you/annai-backup` and the iPhone's token → Save and test: "A backup is already here. An Android phone backed up to you/annai-backup …"; Import it as a copy → preview → Import: the emulator's trips are here.
- [ ] m9 #5 (counted in A): Within a few minutes on Wi-Fi: "Last backup just now"; on GitHub, a commit "annai backup from iPhone".
- [ ] **m9 #8**: Add 10 or more photos: Safari can't tell annai it's on Wi-Fi, so above 25 MB a card says "A large backup is waiting"; Back up now sends it.
- [ ] **m9 #15**: Claude makes a change on the emulator (m9 #14); then you change something here: within a few minutes, "A newer backup is on GitHub. An Android phone backed up … after this phone's last backup."; no commit from the iPhone.
- [ ] **m9 #16**: Import it as a copy: each trip you have says "You already have …", with "Replace mine"; after importing, the iPhone's next backup goes on top of the emulator's (Claude checks the parent).
- [ ] **m9 #17**: Claude makes another change on the emulator; this time, Back up this phone over it: a commit from the iPhone, and the emulator's commit is still in the history.
- [ ] m9 #27 (counted in A): Add the same R2 bucket, its key and a passphrase → Save and test: works; a file named for the iPhone appears.
- [ ] m9 #18, #19, #20, #21 (counted in A): Restore: Export everything; Erase; GitHub → repo and token → Save and test → Import it as a copy (both Replace boxes ticked) → Import: every trip is back (notes with history, photos, plan, bookings) and the models too; type the keys again; Restart.

### C13. Bookings and the real plan (last, after the erasing)

- [ ] **m4 #1**: Wallet → a boarding pass → ⋯ → Share → Save to Files; in the trip, "Add photos or files" → the .pkpass: Shiori writes an unverified booking with the right flight, times and confirmation number. Any pass works; the real one shows up at check-in.
- [ ] **m4 #2**: Mail: a hotel confirmation as a PDF (Share → Print → pinch out → Share → Save to Files), added the same way: Shiori writes the booking and asks only about what she isn't sure of.
- [ ] **m4 #3**: A screenshot of a car rental confirmation, sent with the dock's camera button (choose the photo): the booking's source is the photo's path.
- [ ] m4 #9 (counted in A): "Check this" → the original opens (the pass, the PDF) → "Looks right": the chip goes.
- [ ] m4 #7, #8 (counted in A): Plan the real Thanksgiving trip here: the search links open in Safari, filled in; Directions open Apple Maps.
- [ ] m4 #11 (counted in B): Add to calendar: the share sheet offers Calendar, and the events land at the right local times.
- [ ] m4 #12 (counted in A): Nothing on the Plan or Booking screens scrolls sideways, and every button is easy to hit with a finger.

### C14. After the trip (Nov 30 or later, a short second sitting)

- [ ] m7 #10 (counted in A): Write the recap; time it.
- [ ] m7 #13 (counted in A): Hear Shiori tell it, voice Off, in a quiet room: a few sentences at a time; no microphone dot; any question as buttons; tap her to stop her.
- [ ] m7 #14 (counted in B): Replay opens within a few seconds (time it in Web Inspector).
- [ ] m7 #17, #18 (counted in A): Drag the scrubber with a finger while it plays; tap a photo entry → Open full size → pinch zoom.
- [ ] m7 #9, #20 (counted in A): VoiceOver: the trip card says "N stamps:" and the places; the map says "The route: … km …"; the scrubber says the time and the place; the timeline reads in order; each new place is announced once while it plays.
- [ ] m7 #21 (counted in A): Export the trip as a Backup and hand it to Claude.

## D — Out in the world

By hand, on either phone unless a line says both. Claude reads the Traces when you're back on home Wi-Fi.

### D1. One short walk

Before you leave:
- [ ] m5 #14, #15 (setup): Live mode on, with Live → "Keep the screen on while driving or riding" chosen. Both phones; walk to a café or a shop with a menu.

On the walk:
- [ ] **m5 #15**: Walking, the screen turns off as usual (the choice is per situation). On the next drive (D2), it stays on again.
- [ ] **m2c #1**: At the café, the dock's camera → a photo of the menu: it shows in your bubble, and Shiori says what it is. On both phones.

After:
- [ ] m2c #2 (counted in A): Claude reads Trace → Tools for the photo's two sizes, and Trace → Live for the walk.

### D2. One drive (a normal errand before Thanksgiving, Nov 25–29)

A round trip of 30 km or more gives Shiori two or three chances to narrate.

Before you leave:
- [ ] m5 (setup): On both phones, a short trip with three stops on the route: one fixed with a time (the errand), two flexible, with places. A model set up, voice on Auto, notifications on (C10).
- [ ] m5 #22 (counted in A): Download the offline pack on Wi-Fi.
- [ ] m5 #14 (setup): Car charger and holder. Android in the holder on the way out, iPhone on the way back.
- [ ] m5 #17 (setup): Just before you leave, ask Shiori to remind you of something in 10 minutes. It will fall inside the locked stretch.
- [ ] m5 #28 (setup): Note each phone's battery level.
- [ ] m5 #8–#13 (setup): Claude has rehearsed this drive on the emulator (end of A10).

GPS on:
- [ ] **m5 #8**: Drive off: within a minute the chip says "GPS on · moving fast", voice Auto turns on ("Voice on · moving"), and Now hands over to Driving.
- [ ] **m5 #9**: Driving shows You, the next stops with distances and minutes, Directions in Apple or Google Maps, and the quick-ask buttons; each button gets an answer, aloud (a passenger taps, or wait until parked).
- [ ] **m5 #10**: A moved watch fires every 10–20 km, and she says something worth hearing, or nothing.
- [ ] **m5 #11**: At a plan stop, after about two minutes stopped, she knows you arrived.
- [ ] **m5 #12**: The fixed stop's "leave in about 15 min" comes before you need to leave; dawdle, and "running late" comes.
- [ ] **m5 #13**: Stop 20 minutes somewhere not on the plan: she welcomes the detour, says what it costs, and moves flexible items; the Plan shows "Changed by Shiori · Undo", and Undo puts an item back.
- [ ] **m5 #14**: On the charger, with Keep the screen on: the screen stays on while driving.
- [ ] **m5 #16**: On the way back, the installed app on the iPhone keeps the screen on too.
- [ ] **m5 #17, #18**: Lock the phone for 15 minutes while driving, then unlock: one catch-up wake (she hears how long annai was off screen and how far you went), and the reminder came late, labelled. Nothing fires inside annai while it's locked. With notifications on, a push may come while locked: note it.
- [ ] **m5 #28**: An hour of live mode with the screen on, on the charger, and an hour off it: note the battery used and whether the phone got warm. Another day, an hour of Maps navigation, to compare.
- [ ] m6 #17 (counted in A): After Shiori says a reminder in Driving, no notification follows.
- [ ] m5 #19, #20, #21 (counted in A): If you lose signal on the way, note whether reminders are still spoken and shown.

After (home Wi-Fi):
- [ ] **m5 #29**: Live mode was on all day: close annai and open the trip: the trip, Talk, Plan and Trace → Live each open within about 2 seconds (Claude times the Android; you time the iPhone in Web Inspector).
- [ ] **m5 #30**: Trace → Location: the road as points, about one a second while moving, few while stopped. Trace → Live: the firings, reminders and switches match what happened.
- [ ] m7 #6 (counted in A): Keep this trip and let it back up to GitHub; Claude restores it on the emulator and simulates its recorded track.

### D3. One hour with the phone in a pocket

This can be the same hour as the walk, or any hour out.

Before you leave:
- [ ] m6 (setup): The iPhone with notifications on (C10) and a model; the Android too, if you like.
- [ ] m6 #11 (setup): A fixed plan item one hour ahead, with no place.
- [ ] m6 #22 (setup): Ask for a reminder 8 days out, at a time you'll see it. Then don't open annai on the iPhone until it comes (pick a quiet week before Nov 25).

In your pocket:
- [ ] m6 #6, #7, #8 (counted in A): "Remind me in 5 minutes to check the parking meter" (Settings → Notifications: "1 reminder waiting"); swipe annai away, lock the phone, pocket it: it arrives about 30 seconds after the time, with the trip's name and "check the parking meter" in her words. Note how many seconds late.
- [ ] m6 #9 (counted in A): Tap it: annai opens, and she knows you opened the reminder.
- [ ] m6 #10 (counted in A): Ask for another in 5 minutes; switch to another app (don't close annai); lock: the same notification, and the same catch-up when you tap it.
- [ ] m6 #11 (counted in A): Close annai: "In 15 min: …" arrives 15 minutes before the plan item.
- [ ] m6 #18 (counted in A): On the Android, if you took it: the notification's title and icon, whether it's on the lock screen, and whether a tap opens annai or Chrome first.

After:
- [ ] m6 #9 (counted in A): Trace → Notifications has push.shown and push.opened; Trace → Conversation: the catch-up wake says "The user opened the reminder …" (Web Inspector; Claude reads the Android's over adb).
- [ ] **m6 #22**: Eight days later, with annai unopened in between, the reminder still arrives.

### D4. Things to do in the car

On the D2 drive or any other.

Before you leave:
- [ ] m3 #21, #23 (setup): Parked: phone in the holder, paired with the car's Bluetooth, voice on Auto, music ready, a passenger for any tap. One phone per drive is fine.
- [ ] m7 #13 (setup): Write a recap of the D2 trip at home first, so there's one to hear.

In the car:
- [ ] **m3 #21**: Connected to the car: the chip says "Voice on · car audio" (or "headphones": note which). If it's neither, note the name the car shows in Settings → Voice → Test the microphone's device list.
- [ ] **m3 #8**: Moving, windows up, the passenger taps Test the microphone, and nobody speaks for 15 seconds: "Nothing was heard". Then speak: it hears you.
- [ ] **m3 #23**: The milestone's "Done when": phone in its holder, music playing; tap Shiori once and talk; go on for three or four turns without touching the phone. Note: does the music pause while she speaks and come back after? Is the car's microphone used? Is she loud enough over road noise? Does the end of your sentence get cut off, or does she wait too long (Settings → Voice → the pause)?
- [ ] **m3 #29**: Interrupt her, and talk to a passenger instead of her, as in m3 #10 and #12, with road noise.
- [ ] **m3 #24**: If the car has CarPlay or Android Auto: Maps on the car's screen, annai on the phone: the exchange still works, directions keep speaking; note what the car shows while she speaks.
- [ ] **m3 #26**: Steering-wheel play/pause and next track (or a headset's buttons), with voice on and after she has spoken once: does it tap Shiori (stop her, or start listening)? Note what each button does on each phone.
- [ ] m7 #13 (counted in A): With voice On over Bluetooth, "Hear Shiori tell it" (the D2 trip's recap): she listens after each part.

After (home Wi-Fi):
- [ ] m3 #23, #26, #29 (notes): Claude reads Trace → Conversation for each exchange (what she heard, where you stopped her) and adds it to your notes, with what each steering-wheel button did.

## Coverage

Each item is counted once, in the section where its reference is bold.

| List | Items | A | B | C | D |
|---|---:|---:|---:|---:|---:|
| m1 | 17 | 14 | 0 | 3 | 0 |
| m1b | 14 | 8 | 1 | 5 | 0 |
| m1c | 12 | 12 | 0 | 0 | 0 |
| m2a | 10 | 7 | 1 | 2 | 0 |
| m2b | 21 | 21 | 0 | 0 | 0 |
| m2c | 12 | 11 | 0 | 0 | 1 |
| m3 | 30 | 6 | 14 | 4 | 6 |
| m4 | 12 | 7 | 2 | 3 | 0 |
| m5 | 31 | 16 | 0 | 1 | 14 |
| m6 | 23 | 19 | 0 | 3 | 1 |
| m7 | 21 | 19 | 2 | 0 | 0 |
| m8 | 35 | 34 | 0 | 1 | 0 |
| m9 | 37 | 29 | 0 | 8 | 0 |
| **Total** | **275** | **203** | **20** | **30** | **22** |
