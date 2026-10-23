# Device checklist: milestone 5 (live mode)

The real local drive, on an iPhone and an Android phone, with annai installed to the Home Screen.
Milestone 5's "Done when" is "a real local drive works": this is that drive. Before it, plan a short
trip with three stops in annai (one fixed, two flexible, with places), and have a model set up.
Note what you see in the trip's Trace (kind: Live) after each part.

## Live mode on both phones
- [ ] Open the trip, tap the GPS chip on the dock, and turn GPS on. The phone asks for location once; allow it "While Using". The chip says "GPS on · finding you", then "GPS on · stopped" (or on).
- [ ] Shiori is woken once ("The user turned live mode on"); she sets an activity watch (Trace → Live: no; Trace → Tools: watch_set).
- [ ] Now shows "At …" or "Near …" a plan stop, the sun chips, what's next and the latest card.
- [ ] Close annai fully and open it again: live mode is still on, and nothing is asked again.

## Refused location
- [ ] On one phone, refuse location (or turn it off in Settings). A card says "annai can't see where you are" with steps for this phone; the steps are right for iOS / Android. On iPhone, try it both in a Safari tab (the card points to aA → Website Settings → Location) and in the Home Screen app (Location Services → Safari Websites, and Safari's own Location setting): note whether each path leads to the setting that lets annai see where you are, and what it is called on your iOS version.
- [ ] Live → Where are you? lists the plan's places; choosing one makes Now say "At …".
- [ ] Allow location again, turn live mode off and on: the GPS works.

## The drive
- [ ] Drive off: within a minute the chip says "GPS on · moving fast", voice Auto turns on ("Voice on · moving") and Now hands over to Driving.
- [ ] Driving shows You, the next stops with distances and minutes, Directions in Apple or Google Maps, and the quick-ask buttons; each button gets an answer, aloud.
- [ ] Shiori narrates: a moved watch fires every 10–20 km and she says something worth hearing, or nothing.
- [ ] Arriving at a plan stop: after about two minutes stopped, she knows you arrived.
- [ ] A fixed stop's "leave in about 15 min" reminder comes before you need to leave; "running late" comes if you dawdle.
- [ ] Stop somewhere not on the plan for 20 minutes: she welcomes the detour, says what it costs, and moves flexible items; the Plan shows "Changed by Shiori · Undo", and Undo puts an item back.

## The screen kept on
- [ ] On the car charger, Live → Keep the screen on while driving or riding. The screen stays on while driving.
- [ ] Walk somewhere: the screen turns off as usual (the choice is per situation). Drive again: it stays on again.
- [ ] Installed app on iPhone: the wake lock works there too (it didn't before iOS 18.4).

## Locked and unlocked: catch-up
- [ ] With a time watch due in 10 minutes (ask Shiori to remind you of something), lock the phone for 15 minutes while driving, then unlock.
- [ ] One catch-up wake: she hears how long annai was off screen and how far you went, and the reminder came late, labelled. Nothing fires while locked.

## No connection
- [ ] Turn on airplane mode (or drive where there's no signal) with voice on, and let a watch or a plan reminder come due.
- [ ] The reminder's fallback is said aloud by the phone's own voice and shown as a card; the dock says "Offline · reminders still work".
- [ ] When the connection is back, Shiori hears what came while offline, once.

## The offline pack
- [ ] On the trip's page, Offline pack shows "Download (about … KB)" before anything is downloaded. On Wi-Fi, tap it: it shows each part as it goes, then "Downloaded just now · … · … places, … Wikipedia summaries, … Wikivoyage guides" and the guides' names. When OpenStreetMap is busy this takes several minutes (8 for Big Sur on 2026-10-16); leave annai open, or tap Stop and later "Download the rest".
- [ ] Trace → Web: the requests went to overpass-api.de, en.wikipedia.org and en.wikivoyage.org only, one at a time, about a second apart, and a "pack.download" line sums it up.
- [ ] Android, on Wi-Fi with the trip open: ask Shiori to add a stop to the plan. Within a few minutes the panel says "Downloaded just now" again, without a tap (Trace → Web: "by itself on Wi-Fi").
- [ ] iPhone: the panel says Safari doesn't tell annai when it is on Wi-Fi; after a plan change it offers "Update (about … KB)".
- [ ] Airplane mode, at a stop on the plan: ask "What's around here?" and "Tell me about Big Sur" (or the trip's destination). Shiori answers from the pack, and says it comes from the offline pack; Now says "Near …" a place the pack names.
- [ ] Still in airplane mode, ask about a place far off the plan: she says OpenStreetMap and Wikipedia didn't answer.

## Battery
- [ ] An hour of live mode with the screen on (on the charger, and once off it): note the battery used, and whether the phone got warm. Compare with an hour of Maps navigation.

## Afterwards
- [ ] After a day of live mode (thousands of location points in the trip), close annai and open the trip again: the trip, Talk, Plan and Trace → Live each open within about 2 seconds (time them on both phones).
- [ ] Trace → Location: the road is there as location points, about one a second while moving, few while stopped. Trace → Live: the firings, reminders and switches match what happened.
- [ ] Export the trip as a Backup, then remove it from its page. The toast says how much space was freed (a day of location points is in it), the trip is gone from Trips, and turning live mode on again fires none of its watches.
