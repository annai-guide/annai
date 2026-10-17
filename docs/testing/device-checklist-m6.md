# Device checklist: milestone 6 (push relay)

Milestone 6's "Done when": a reminder arrives on a locked iPhone and opens a catch-up wake. This is
that test, on an iPhone (iOS 16.4 or later) and an Android phone, with annai installed to the Home
Screen and served over HTTPS, and a model set up.

## The relay

Before the relay is deployed, use the one in Node on the machine that serves annai to the phones
(`relay/README.md`, "A device test before deploying"):

    node relay/serve.mjs --port 8796 --origin https://<machine>.<tailnet>.ts.net:8792
    tailscale serve --bg --https=8797 http://127.0.0.1:8796

Once it is deployed, use `https://push.annai.guide` (the default).

## Turning notifications on (both phones)
- [ ] iPhone, annai in a Safari tab: Settings → Notifications says notifications work only in the Home Screen app, and how to add it.
- [ ] From the Home Screen app: Settings → Notifications → Relay address (the tailnet one, or leave the default) → Save address → Turn on notifications. The phone asks once; allow.
- [ ] Within seconds, a notification: "Notifications are on. Reminders come like this while annai is closed." The screen says "On · 0 reminders waiting at the relay."
- [ ] Refuse once, on one phone (turn off, then on, and choose Don't Allow): the screen says where to allow it, and the words are right for that phone.
- [ ] Send a test notification, then lock the phone at once: it arrives on the lock screen about 15 seconds after the tap.

## A reminder while annai is closed (the "Done when")
- [ ] Ask Shiori: "Remind me in 5 minutes to check the parking meter." Settings → Notifications: "1 reminder waiting".
- [ ] Close annai fully (swipe it away), lock the phone, wait.
- [ ] The notification arrives on the locked phone, about 30 seconds after the time: the trip's name, and "check the parking meter" in Shiori's words. Note how many seconds late it was.
- [ ] Tap it. annai opens and Shiori catches up: she knows you opened the reminder, and that it was shown (Trace → Notifications: push.shown and push.opened; Trace → Conversation: the catch-up wake says "The user opened the reminder …").
- [ ] Same again, but with annai in the background (another app open) rather than closed: the same notification, the same catch-up when you tap it.
- [ ] A plan reminder: a fixed plan item an hour ahead with no place. Close annai; "In 15 min: …" arrives 15 minutes before it.

## Cancelling and changing
- [ ] Ask for a reminder in 10 minutes, then ask Shiori to cancel it. Close annai and wait 12 minutes: nothing arrives.
- [ ] Move a plan item later (Plan screen, or ask Shiori). Its "coming up" arrives at the new time, not the old.
- [ ] A trip with a reminder waiting: remove the trip. Nothing arrives for it.
- [ ] Turn notifications off: "0 reminders waiting", and no reminder arrives.

## No second reminder while annai is open
- [ ] With annai open on screen (live mode on, or Now), let a reminder come due. Shiori says it on the phone, and no notification follows in the next minute.
- [ ] Same with the screen kept on in the car (Driving): no notification after Shiori's reminder.

## Android
- [ ] Note what Android shows: the notification's title, text and icon; whether it appears on the lock screen; whether tapping it opens annai or Chrome first.
- [ ] Android with annai in the background but not closed: the notification arrives, and the catch-up follows the tap.

## iPhone specifics
- [ ] Focus mode on: the notification follows the Focus settings (held or allowed).
- [ ] After a phone restart, notifications still arrive (no need to turn them on again). If they don't, note it: annai should have shown a card saying how to turn them back on.
- [ ] After a week without using annai, a reminder still arrives.

## The relay's privacy
- [ ] Trace, System · This device: each request to the relay is a web request ("push relay", a URL and a status); no token or key appears in any of them.
