# Device checklist: milestone 4 (planning and bookings)

The done criterion is the real Thanksgiving trip (Nov 25–29, 2026), planned and with its bookings imported, on an iPhone and an Android phone, in the app installed to the Home Screen. Open annai over HTTPS: annai.guide once it is deployed, or during development your machine's tailnet address from `tailscale serve`. Each address keeps its own data, so use the one you will travel with.

## Bringing bookings in

- [ ] iPhone, Wallet: share a boarding pass (Wallet → the pass → ⋯ → Share → Save to Files), then in the trip, "Add photos or files" → the .pkpass. Shiori reads it and writes an unverified booking with the right flight, times and confirmation number.
- [ ] iPhone, Mail: a hotel confirmation as a PDF (Share → Print → pinch out → Share → Save to Files), added the same way. Shiori writes the booking; she asks only about what she isn't sure of.
- [ ] iPhone: a screenshot of a car rental confirmation, sent with the dock's camera button (choose the photo). Shiori writes the booking from the photo, with source set to the photo's path.
- [ ] Android, Gmail: share a confirmation email to annai (Share → annai). It arrives as "shared text.txt"; add it to the trip; Shiori writes the booking.
- [ ] Android: share a .pkpass or a PDF from Files to annai. "Add to Thanksgiving" adds it, and Shiori is woken once.
- [ ] Two confirmations with the same file name are both kept ("confirmation (2).pdf").

## Planning

- [ ] Ask Shiori to plan the trip. She goes in the brief's order (getting there, getting around, where to stay, the rest) and hands over search links (flights, hotels, cars) and directions as cards; the links open the right sites prefilled.
- [ ] The Plan shows each day of the trip as a tab, flights and check-ins as ● fixed, the rest as ○ flexible, times in each place's own zone, and the legs between stops with Directions into Apple Maps (iPhone) or Google Maps (Android).
- [ ] Each unconfirmed booking shows "Check this"; on the Booking screen, the original opens, and "Looks right" confirms it. The chip goes away.
- [ ] Your calendar's export of the trip's dates (.ics) adds plan items once; adding it again changes nothing.
- [ ] "Add to calendar": on iPhone the share sheet offers Calendar, and the events land at the right local times; on Android, Google Calendar imports the file.
- [ ] Nothing on the Plan or Booking screens scrolls sideways; every button is easy to hit.
