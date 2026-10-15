# Milestone 1: device checklist

Run on a real iPhone (Safari, iOS 26+) and a real Android phone (Chrome), against the deployed site or the dev server tunnelled over HTTPS.

## Install and storage
- [ ] In a browser tab, the "annai isn't installed yet" card shows. "Show me how" lists the right steps for the phone.
- [ ] Android: the "Install annai" button appears and installs the app.
- [ ] iPhone: Share → Add to Home Screen; open from the Home Screen; the warning is gone.
- [ ] Settings → Storage says "Protected from automatic clearing: yes" in the installed app (tap "Protect my data" if not).

## Offline
- [ ] With the installed app opened once, turn on airplane mode, force-quit and reopen: Trips loads and trips are there.

## Trips and files
- [ ] Create a trip with Japanese text in its name. Add a note, edit it twice, restore the first version.
- [ ] Upload a photo from the camera roll; it shows on the file screen.

## Export and import
- [ ] Export everything with a passphrase. "Save file" opens the share sheet; save to Files (iPhone) or Downloads (Android).
- [ ] Settings → Erase → type ERASE → Erase now. Trips is empty.
- [ ] Open the saved file from Trips → "Open a trip someone sent you", enter the passphrase, tick "Replace my profile and memory", Import. Everything is back, including history.
- [ ] Android: share a `.annai.zip` from Files to annai; the import screen opens with it.
- [ ] AirDrop or message a trip export to the other phone and import it there.

## One instance and errors
- [ ] Open annai in a second Safari/Chrome tab: "annai is open in another tab" → "Use it here"; the first tab shows that it stopped.

## Plugins (service worker)
- [ ] Install `test/fixtures/plugins/hello` zipped; creating `/hello/a.json` in a trip is refused until the plugin is turned off.

## Updates
- [ ] Deploy a version bump while the app is open: "An update is ready" appears; it does not reload by itself; "Restart now" reloads into the new version.
