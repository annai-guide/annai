import { VERSION } from '../../app/version.js';
import { loadLinks, mapsLinks, searchLinks } from '../../core/links.js';

export const manifest = {
  id: 'go',
  name: 'Go tools',
  version: VERSION,
  api: 1,
  description: 'maps_link and search_link: directions, and prefilled flight, hotel and car searches for you to book.',
};

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
  const off = tools.map((t) => annai.tools.register(t));
  return () => off.forEach((fn) => fn());
}
