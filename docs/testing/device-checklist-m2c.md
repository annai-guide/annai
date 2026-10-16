# Milestone 2c: device checklist (photos to the model)

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), installed to the Home Screen, over HTTPS. Set up an Anthropic endpoint (photos upload there) and an OpenRouter one.

## Photos
- [ ] Tap the camera in the dock and take a photo of a menu: it shows in your bubble, and Shiori says what it is.
- [ ] Trace → Tools: Shiori's read of a photo says both sizes ("4032×3024, sent as 2000×1500").
- [ ] Ask about a detail ("what does the small print say?"): Shiori reads a region; the trace shows the part she cut.
- [ ] Open a photo from the trip's files, zoom to a part, tap "Show Shiori this part": she answers about that part.
- [ ] With the Anthropic endpoint: Trace → Web shows one upload per photo (kind upload); later turns don't upload it again.
- [ ] The Test button on the Anthropic model shows "Photo uploads work"; on the endpoint's page, turn uploads off and see photos go in each request instead.
- [ ] Set Settings → Photos → Photos for Shiori to 1000 px: photos are smaller; a closer look still shows detail.
- [ ] A model that refuses big photos (set its image limit high, then send a large photo): the photo is resent smaller by itself, and the model's page keeps the new limit.
- [ ] Raise "Largest photo sent" to 5 MB and send a large photo to Claude: if Claude counts the limit on the encoded text, the repair makes it smaller once and it goes through.
- [ ] Reload while Shiori is thinking about a photo: after the reload she answers it (Safari cancels the request as the reload begins).
- [ ] Remove a trip full of photos: the space comes back at once (Settings → Storage), and another trip's photos are untouched.

## Finish line
- [ ] Milestone 2 is done: a text-and-photo conversation with tool use works with fallback across two providers, and the trace shows everything. A refused photo is repaired without the user doing anything.
