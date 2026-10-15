# Vision

The original brief for annai, organized but not yet designed. Nothing here is
a technical decision; it is the input to the design phase.

## What it is

A web-page agent harness that acts as a personal tour guide. It runs on the
user's smartphone first, as a fully featured app delivered as a web page so
people can load it instantly and skip app-store approval.

- Uses as many local (on-device, in-browser) resources as possible.
- Persistent: data is stored in the browser.
- Open source.
- The user supplies their own LLM API endpoint(s).
- Targets only modern, capable devices and browsers.
- Needs as little user interaction as possible for the agent to be useful.

## Core model

- **A trip is a project**, in the coding-agent sense. Each trip holds:
  transcripts; whatever the agent decides to store or writes intentionally;
  files and photos the user ingested; extracted booking records.
- **Memory** at two levels: per-trip, and global (e.g. user preferences that
  carry across trips).
- **User profile**: what the agent should call the user, preferences, etc. No
  username/password credentials.
- **Tools**: the agent acts through tool calls: interacting with the
  application and its storage, running searches, and so on.
- **Automation**: the agent can set up hooks, background tasks and
  notifications.

## Before the trip: planning

Request-driven: the user interacts, the agent runs its loop.

1. Collect the user's information.
2. Plan in order, roughly: getting there (flights etc.) → getting around
   (car rental or other options) → lodging → and so on.
3. **Import existing bookings**: the user imports files or images of bookings
   they already have; the agent extracts the information and keeps it on
   record.

## During the trip: live mode

While the user keeps the app open, a mode loops automatically. The agent is
woken by triggers and then analyses the current situation and responds.

- **Triggers**: time passing, GPS location change, arriving at a place, or
  other triggers firing.
- **Outputs**: insights about the location, reminders of what to do, live
  replanning (missed something, stayed too long, change of plan, …),
  suggestions for next actions.
- **Manual wake**: the user can wake the agent with text, images (photos), and
  ideally voice.

## After the trip

- Summarize memories and recap the trip.
- Export the trip as an archive.
- Replay the trip.

## Data and hosting

- The website only serves the application and keeps minimal user information.
- Almost everything is stored in the user's browser.
- Export and import of all data, so a user can move to another device (e.g.
  from phone to computer).

## Known constraint: browser storage can be evicted

Safari on iOS deletes a site's script-writable storage after about 7 days of
Safari use without visiting that site, unless the site has been added to the
Home Screen. Any browser may also evict data under storage pressure. Trips are
planned weeks ahead, so this would silently lose data.

Decided:

- Prompt the user to install annai to the Home Screen (PWA).
- When not running as an installed PWA, warn clearly that data can be lost
  forever.
- Request persistent storage from the browser.
- Make export/backup easy to do often.
