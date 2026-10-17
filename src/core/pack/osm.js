/**
 * OpenStreetMap places, for the nearby tool and the offline pack (spec §8, §11.5): the kinds nearby
 * knows as Overpass filters, which kinds a place's tags make it, and a place as one short row.
 * @typedef {[id: string, name: string, kind: string, lat: number, lng: number, note: string, kinds: string]} OsmRow
 *   id: "n123" (node), "w45" (way), "r6" (relation); kind: the tag value nearby shows ("viewpoint",
 *   "historic castle"); note: its website or Wikipedia tag; kinds: the kinds it is, comma-separated
 */

/** The Overpass servers, in the order they are asked. */
export const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/** Each kind's tags: a key, and the values it takes (matched whole), or null for any value. */
export const KINDS = /** @type {Readonly<Record<string, [string, string | null][]>>} */ (Object.freeze({
  sights: [['tourism', 'attraction|viewpoint|museum|gallery|artwork|zoo|aquarium'], ['historic', null], ['natural', 'waterfall|peak|beach|cave_entrance|arch']],
  food: [['amenity', 'restaurant|cafe|fast_food|bar|pub|ice_cream']],
  fuel: [['amenity', 'fuel|charging_station']],
  parking: [['amenity', 'parking']],
  toilets: [['amenity', 'toilets']],
  lodging: [['tourism', 'hotel|motel|guest_house|hostel|camp_site']],
  shops: [['shop', 'supermarket|convenience|bakery']],
  parks: [['leisure', 'park|nature_reserve'], ['boundary', 'national_park']],
}));
export const KIND_NAMES = Object.keys(KINDS);
/** Kinds that are useful without a name: most toilets and car parks have none. The others are asked for with one. */
export const UNNAMED = new Set(['fuel', 'parking', 'toilets']);

/** The Overpass filters for some kinds: "[amenity=toilets]", '[amenity~"^(restaurant|cafe)$"][name]'. @param {string[]} kinds */
export function overpassFilters(kinds) {
  return kinds.flatMap((k) => (KINDS[k] ?? []).map(([key, values]) => {
    const tag = values === null ? key : values.includes('|') ? `${key}~"^(${values})$"` : `${key}=${values}`;
    return `[${tag}]${UNNAMED.has(k) ? '' : '[name]'}`;
  }));
}

/** The kinds a place's tags make it, in KINDS order. @param {Record<string, unknown>} tags */
export function kindsOf(tags) {
  return KIND_NAMES.filter((k) => (UNNAMED.has(k) || typeof tags.name === 'string') && KINDS[k].some(([key, values]) => {
    const v = tags[key];
    return typeof v === 'string' && (values === null || values.split('|').includes(v));
  }));
}

const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');

/** An Overpass element as a row, or null when it has no position. @param {any} e @returns {OsmRow | null} */
export function osmRow(e) {
  const lat = e?.lat ?? e?.center?.lat;
  const lng = e?.lon ?? e?.center?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const t = e.tags && typeof e.tags === 'object' ? e.tags : {};
  const kind = str(t.tourism) || str(t.amenity) || str(t.natural) || str(t.leisure) || str(t.shop) || (t.historic ? `historic ${str(t.historic)}` : str(t.boundary));
  return [`${str(e.type).charAt(0) || 'x'}${e.id ?? ''}`, str(t.name) || str(t.brand) || str(t.operator), kind, r4(lat), r4(lng), str(t.website) || str(t.wikipedia), kindsOf(t).join(',')];
}
