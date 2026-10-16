# Milestone 1b: device checklist (photos)

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), with annai installed to the Home Screen, against a deployed preview or the dev server tunnelled over HTTPS.

## Adding photos
- [ ] iPhone: in a trip, "Take a photo" and take one holding the phone sideways. It's listed as `/files/<date>-<time>.jpg` (Safari can't write WebP), shows upright, and its page says when it was taken and, if the Camera may use your location, where.
- [ ] iPhone: "Add photos or files" and pick three 12 MP photos from the library (HEIC). "Adding 2 of 3…" shows; each is stored as `.jpg`, and each page shows 4032 × 3024 (or 3024 × 4032).
- [ ] Android: "Take a photo" and "Add photos or files" do the same, storing `.webp`.
- [ ] A 24 or 48 MP photo (the default on iPhone 15 Pro and later): it's stored at about 16.7 megapixels and is neither blank nor black. This checks the canvas limit; a blank photo means `MAX_CANVAS_PIXELS` is too high for this phone.
- [ ] A screenshot is stored as WebP or JPEG, and its text is still readable when you zoom in.
- [ ] Android: share two photos from Google Photos to annai. "Add 2 photos" → "Add to <trip>" → both are in the trip.

## Viewing
- [ ] Tap a photo: it opens full screen. Pinch to zoom, drag to move, double-tap to zoom in and back out; Close returns to the photo's page.
- [ ] "Where it was taken" opens OpenStreetMap at the right place.

## Keep originals
- [ ] Settings → Photos → Keep originals → Save photo settings. On the iPhone, add a HEIC photo: it's stored as `.heic`, shows on the iPhone, and its page says "Stored as taken".
- [ ] Export that trip as a Share and import it on the Android phone: the photo arrives as JPEG or WebP and shows.
- [ ] Export it as a Backup and import it on the Android phone: the photo arrives as HEIC, and its page says this browser can't show it.

## Sharing and backup
- [ ] Export a trip as a Share with "Include where photos were taken" off, and import it on the other phone: the photos show, and their pages have no "Where it was taken".
- [ ] The same with the box ticked: the location is there.
- [ ] Milestone 1b's finish line: a 12 MP iPhone photo and an Android photo, exported as a Backup and imported on the other phone, both show in both browsers.
