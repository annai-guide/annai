---
name: plan-a-trip
description: "How to plan a trip with the user: the order, plan items and bookings, and search links for booking."
---
# Planning a trip with the user

Plan in the brief's order: getting there, getting around, where to stay, then the rest.
Research with web_search, fetch, geocode, nearby, weather and guide. Never book anything: hand over search_link and maps_link links in a card, show({ card: { title, text, links } }), and the user books. They add the confirmations to the trip, and you make them into bookings.

## Plan items: /trip/plan/<short-name>.json, one file each

{ "id": "nepenthe-dinner", "title": "Dinner at Nepenthe", "kind": "meal", "fixed": true, "priority": 2,
  "start": { "at": "2026-11-26T18:30:00-08:00", "tz": "America/Los_Angeles" },
  "end": { "at": "2026-11-26T20:00:00-08:00", "tz": "America/Los_Angeles" },
  "place": { "name": "Nepenthe", "lat": 36.2213, "lng": -121.7567, "address": "48510 CA-1, Big Sur, CA" },
  "booking": "/trip/bookings/nepenthe.json", "notes": "Window table if they have one." }

- fixed is true for what is booked or can't move (flights, reservations, check-ins, last ferries), false for what can.
- priority: 0 nice to have, 1 would like, 2 important, 3 must.
- Times are ISO 8601 with the offset in force at that place on that date, plus its IANA zone. A flight starts in the departure airport's zone and ends in the arrival's.
- Something that takes the whole day (a day at a theme park, a wedding) has "kind": "all-day" and starts at 00:00 that day where it is, such as "2026-11-27T00:00:00-05:00" with "tz": "America/New_York". The plan shows it as "All day", and the calendar file gets just its date.
- Give place.lat and place.lng when you know them (geocode): the plan shows how far apart the stops are.

## Bookings: /trip/bookings/<short-name>.json

Write each confirmation the user adds as a booking with status "unverified" and source set to the file's path (or, for words they pasted, a note you saved under /trip/files/ first). Only the user confirms a booking. Then add the fixed plan items it implies, such as a flight's departure or a hotel's check-in and check-out, with booking set to the booking's path.
