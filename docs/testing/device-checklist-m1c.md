# Milestone 1c: device checklist (removing trips)

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), with annai installed to the Home Screen, against a deployed preview or the dev server tunnelled over HTTPS.

## The questions
- [ ] Start a trip and add 30 photos. On Trips, its card says "not backed up".
- [ ] Open the trip and tap Remove trip. The first question names the trip. Cancel keeps it. Swipe or press Escape to dismiss it: the trip stays.
- [ ] Remove trip → Remove: "Not backed up" appears. Cancel keeps the trip.
- [ ] Export trip → Backup → Build file → Save file (Save to Files on the iPhone). On Trips, the card says "backed up just now".
- [ ] A Share export doesn't count: Export trip → Share → Save. The card still says when the last Backup was.
- [ ] Add a note to the trip: the card says "changed since". Archive and unarchive a backed-up, unchanged trip: the card doesn't.

## Space comes back
- [ ] In Settings, write down "Using X of about Y".
- [ ] Back up the trip with the 30 photos, then remove it. Only the first question appears. Trips shows "Removed <trip>. N MB freed.", and the card is gone.
- [ ] Settings shows usage lower by about N MB. If it hasn't dropped, close annai fully, reopen it, and look again. Write down what you saw on each phone: Safari's database may hand space back to the phone later than Chrome does, though annai reuses it either way.
- [ ] Import the Backup: the trip comes back with all 30 photos.

## Finish line
- [ ] Milestone 1c is done: on both phones, removing a trip full of photos gives its space back, and the backup warning shows exactly when the trip changed after its last Backup.
