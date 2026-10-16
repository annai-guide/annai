import { VERSION } from '../../app/version.js';
import { loadLinks, mapsLinks, searchLinks } from '../../core/links.js';

export const manifest = {
  id: 'go',
  name: 'Go tools',
  version: VERSION,
  api: 1,
  description: 'maps_link and search_link: directions, and prefilled flight, hotel and car searches for you to book; and how Shiori plans a trip.',
};

/** How Shiori plans (spec §8), loaded with the skill tool when she plans. */
const PLANNING = `# Planning a trip with the user

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

Write each confirmation the user adds as a booking with status "unverified" and source set to the file's path (or, for words they pasted, a note you saved under /trip/files/ first). Only the user confirms a booking. Then add the fixed plan items it implies, such as a flight's departure or a hotel's check-in and check-out, with booking set to the booking's path.`;

/** @param {any} annai */
export function activate(annai) {
  /** The catalog, or a plain error. @param {any} call */
  const catalog = async (call) => {
    const c = await loadLinks({ ws: annai.files, fetch: call.fetch });
    if (!c) throw new Error("annai hasn't downloaded its link formats yet. It needs to be online once; try again when it is.");
    return c;
  };
  const tools = [
    {
      name: 'maps_link', group: 'Go',
      description: 'Directions in Apple Maps and Google Maps. Hand them to the user in a card: show({ card: { links } }). destination and origin are a name, an address, or "lat,lng"; without an origin, the maps app starts where the user is.',
      input: {
        type: 'object', required: ['destination'],
        properties: { destination: { type: 'string' }, origin: { type: 'string' }, mode: { enum: ['drive', 'walk', 'transit', 'bike'], default: 'drive' } },
      },
      /** @param {{ destination: string, origin?: string, mode?: string }} i @param {any} call */
      run: async (i, call) => ({ links: mapsLinks(await catalog(call), i) }),
    },
    {
      name: 'search_link', group: 'Go',
      description: 'Prefilled searches on booking sites, for the user to book (annai never books). Hand them over in a card: show({ card: { links } }). kind and params: flight { from, to, depart, return?, adults? } with airport codes such as SFO; hotel { place, checkin, checkout, adults?, rooms? }; car { place, pickup, dropoff }. Dates are YYYY-MM-DD.',
      input: {
        type: 'object', required: ['kind', 'params'],
        properties: { kind: { enum: ['flight', 'hotel', 'car'] }, params: { type: 'object', additionalProperties: { type: ['string', 'number'] } } },
      },
      /** @param {{ kind: string, params: Record<string, unknown> }} i @param {any} call */
      run: async (i, call) => ({ links: searchLinks(await catalog(call), i.kind, i.params ?? {}) }),
    },
  ];
  const off = [...tools.map((t) => annai.tools.register(t)), annai.register('skill', { name: 'plan-a-trip', description: 'How to plan a trip with the user: the order, plan items and bookings, and search links for booking.', text: PLANNING })];
  return () => off.forEach((fn) => fn());
}
