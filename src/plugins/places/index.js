import { VERSION } from '../../app/version.js';

export const manifest = {
  id: 'places',
  name: 'Places tools',
  version: VERSION,
  api: 1,
  description: 'nearby, geocode, reverse, weather and guide, from OpenStreetMap, Wikipedia, Nominatim, Open-Meteo and Wikivoyage.',
};

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const NOMINATIM = 'https://nominatim.openstreetmap.org';
/** Nominatim allows one request a second (spec §7.2); the gap is a little more. */
export const NOMINATIM_GAP = { ms: 1100 };

/** OpenStreetMap tags for each kind of place nearby knows; patterns match whole values ("pub", not "public_bookcase"). */
export const KINDS = Object.freeze({
  sights: ['tourism~"^(attraction|viewpoint|museum|gallery|artwork|zoo|aquarium)$"', 'historic', 'natural~"^(waterfall|peak|beach|cave_entrance|arch)$"'],
  food: ['amenity~"^(restaurant|cafe|fast_food|bar|pub|ice_cream)$"'],
  fuel: ['amenity~"^(fuel|charging_station)$"'],
  parking: ['amenity=parking'],
  toilets: ['amenity=toilets'],
  lodging: ['tourism~"^(hotel|motel|guest_house|hostel|camp_site)$"'],
  shops: ['shop~"^(supermarket|convenience|bakery)$"'],
  parks: ['leisure~"^(park|nature_reserve)$"', 'boundary=national_park'],
});
/** Kinds that are useful without a name: most toilets and car parks have none. The other kinds are asked for with one. */
const UNNAMED = new Set(['fuel', 'parking', 'toilets']);

const WEATHER = /** @type {Record<number, string>} */ ({
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
});

/** Meters between two points. @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
function meters(lat1, lng1, lat2, lng2) {
  const r = (/** @type {number} */ d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const round = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
const POINT = { lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 } };

/** @param {any} annai */
export function activate(annai) {
  const { tsv } = annai.helpers;
  let nextNominatim = 0;
  /** Calls Nominatim no faster than once a second, across geocode and reverse. @param {string} url @param {any} call */
  const nominatim = async (url, call) => {
    const wait = nextNominatim - Date.now();
    nextNominatim = Math.max(Date.now(), nextNominatim) + NOMINATIM_GAP.ms;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // Nominatim's usage policy asks apps to say who they are. The app's own policy sends no
    // Referer, so this request sends the origin, which its Origin header shows anyway.
    const res = await call.fetch(url, { signal: call.signal, headers: { accept: 'application/json' }, referrerPolicy: 'origin' });
    if (!res.ok) throw new Error(`Nominatim answered ${res.status}.`);
    return res.json();
  };
  /** @param {string} url @param {any} call */
  const json = async (url, call, init = {}) => {
    const res = await call.fetch(url, { signal: call.signal, ...init });
    if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}.`);
    return res.json();
  };

  const tools = [
    {
      name: 'nearby', group: 'Places',
      description: `Places near a point, nearest first, as TSV: name, kind, distance_m, lat, lng, source, note. kinds: ${Object.keys(KINDS).join(', ')} (default sights and food).`,
      input: { type: 'object', properties: { ...POINT, radius: { type: 'number', minimum: 50, maximum: 20000, description: 'Meters, default 1000.' }, kinds: { type: 'array', items: { enum: Object.keys(KINDS) } } }, required: ['lat', 'lng'] },
      /** @param {{ lat: number, lng: number, radius?: number, kinds?: string[] }} i @param {any} call */
      async run(i, call) {
        const radius = Math.round(Math.min(20000, Math.max(50, i.radius ?? 1000)));
        const at = `around:${radius},${round(i.lat)},${round(i.lng)}`;
        const filters = (i.kinds?.length ? i.kinds : ['sights', 'food'])
          .flatMap((k) => (/** @type {any} */ (KINDS)[k] ?? []).map((/** @type {string} */ f) => `[${f}]${UNNAMED.has(k) ? '' : '[name]'}`));
        // Overpass cuts its output in id order, not by distance, so ask for plenty and keep the nearest 40.
        const query = `[out:json][timeout:20];(${filters.map((f) => `nwr(${at})${f};`).join('')});out center tags 400;`;
        /** @type {any[]} */
        const rows = [];
        let osm = false;
        for (const server of OVERPASS) {
          try {
            const data = await json(server, call, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
            for (const e of data.elements ?? []) {
              const lat = e.lat ?? e.center?.lat;
              const lng = e.lon ?? e.center?.lon;
              if (lat === undefined) continue;
              const t = e.tags ?? {};
              const kind = t.tourism ?? t.amenity ?? t.natural ?? t.leisure ?? t.shop ?? (t.historic ? `historic ${t.historic}` : t.boundary ?? '');
              rows.push([t.name ?? t.brand ?? t.operator ?? '', kind, Math.round(meters(i.lat, i.lng, lat, lng)), round(lat), round(lng), 'osm', t.website ?? t.wikipedia ?? '']);
            }
            osm = true;
            break;
          } catch (e) {
            if (call.signal.aborted) throw e;
          }
        }
        try {
          const w = await json(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${round(i.lat)}%7C${round(i.lng)}&gsradius=${Math.min(radius, 10000)}&gslimit=30&format=json&origin=*`, call);
          for (const g of w.query?.geosearch ?? []) {
            rows.push([g.title, 'wikipedia article', Math.round(g.dist), round(g.lat), round(g.lon), 'wikipedia', `https://en.wikipedia.org/wiki/${encodeURIComponent(g.title.replace(/ /g, '_'))}`]);
          }
        } catch (e) {
          if (call.signal.aborted) throw e;
          if (!osm) throw new Error("Neither OpenStreetMap nor Wikipedia answered. Try again in a moment.");
        }
        rows.sort((a, b) => a[2] - b[2]);
        const out = tsv(['name', 'kind', 'distance_m', 'lat', 'lng', 'source', 'note'], rows.slice(0, 40));
        return osm ? out : `${out}\nOpenStreetMap didn't answer; these are Wikipedia articles only.`;
      },
    },
    {
      name: 'geocode', group: 'Places',
      description: 'Find a place by name or address, as TSV: name, lat, lng, type.',
      input: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] },
      /** @param {{ query: string }} i @param {any} call */
      async run(i, call) {
        const found = await nominatim(`${NOMINATIM}/search?q=${encodeURIComponent(i.query)}&format=jsonv2&limit=5`, call);
        if (!found.length) return `Nothing found for "${i.query}".`;
        return tsv(['name', 'lat', 'lng', 'type'], found.map((/** @type {any} */ f) => [f.display_name, f.lat, f.lon, `${f.category ?? f.class}/${f.type}`]));
      },
    },
    {
      name: 'reverse', group: 'Places',
      description: 'What is at a point: its name, address and type.',
      input: { type: 'object', properties: POINT, required: ['lat', 'lng'] },
      /** @param {{ lat: number, lng: number }} i @param {any} call */
      async run(i, call) {
        const f = await nominatim(`${NOMINATIM}/reverse?lat=${i.lat}&lon=${i.lng}&format=jsonv2&zoom=18`, call);
        if (f.error) return `Nothing is known at ${i.lat}, ${i.lng}.`;
        return JSON.stringify({ name: f.name ?? '', address: f.display_name ?? '', type: `${f.category ?? f.class}/${f.type}` });
      },
    },
    {
      name: 'weather', group: 'Places',
      description: "The weather at a point: its time zone, the day's range, sunrise and sunset, and hourly TSV. when: a date (YYYY-MM-DD) up to 16 days ahead; default the next 24 hours.",
      input: { type: 'object', properties: { ...POINT, when: { type: 'string' } }, required: ['lat', 'lng'] },
      /** @param {{ lat: number, lng: number, when?: string }} i @param {any} call */
      async run(i, call) {
        const w = await json(`https://api.open-meteo.com/v1/forecast?latitude=${round(i.lat)}&longitude=${round(i.lng)}`
          + '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m'
          + '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=16', call);
        const day = i.when ? String(i.when).slice(0, 10) : null;
        const h = w.hourly ?? {};
        const times = /** @type {string[]} */ (h.time ?? []);
        let idx = times.map((_, k) => k);
        if (day) idx = idx.filter((k) => times[k].startsWith(day));
        else {
          const nowLocal = times.findIndex((t) => Date.parse(`${t}:00Z`) >= Date.now() + (w.utc_offset_seconds ?? 0) * 1000 - 3_600_000);
          idx = idx.slice(Math.max(0, nowLocal), Math.max(0, nowLocal) + 24);
        }
        if (!idx.length) return `No forecast for ${day ?? 'that time'}: Open-Meteo forecasts 16 days ahead.`;
        const d = w.daily ?? {};
        const di = (d.time ?? []).indexOf(times[idx[0]].slice(0, 10));
        const lines = [`Time zone: ${w.timezone}${w.timezone_abbreviation ? ` (${w.timezone_abbreviation})` : ''}`];
        if (di >= 0) {
          lines.push(`${d.time[di]}: ${Math.round(d.temperature_2m_min[di])} to ${Math.round(d.temperature_2m_max[di])} °C, rain chance up to ${d.precipitation_probability_max[di]}%, `
            + `sunrise ${String(d.sunrise[di]).slice(11)}, sunset ${String(d.sunset[di]).slice(11)}`);
        }
        lines.push(tsv(['time', 'temp_c', 'rain_chance_pct', 'rain_mm', 'weather', 'wind_kmh'],
          idx.map((k) => [times[k], h.temperature_2m?.[k], h.precipitation_probability?.[k], h.precipitation?.[k], WEATHER[h.weather_code?.[k]] ?? h.weather_code?.[k], h.wind_speed_10m?.[k]])));
        return lines.join('\n');
      },
    },
    {
      name: 'guide', group: 'Places',
      description: "A Wikivoyage travel guide for a place: its introduction and sections (Understand, See, Do, Eat, Sleep…); ask for one section to read it.",
      input: { type: 'object', properties: { place: { type: 'string', minLength: 1 }, section: { type: 'string' } }, required: ['place'] },
      /** @param {{ place: string, section?: string }} i @param {any} call */
      async run(i, call) {
        const base = 'https://en.wikivoyage.org/w/api.php';
        const r = await json(`${base}?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=${encodeURIComponent(i.place)}&format=json&origin=*`, call);
        const page = /** @type {any} */ (Object.values(r.query?.pages ?? {})[0]);
        if (!page || page.missing !== undefined || !page.extract) {
          const s = await json(`${base}?action=opensearch&search=${encodeURIComponent(i.place)}&limit=5&namespace=0&format=json&origin=*`, call).catch(() => null);
          const close = Array.isArray(s?.[1]) ? s[1] : [];
          return `Wikivoyage has no article called "${i.place}".${close.length ? ` Close ones: ${close.join(', ')}.` : ''}`;
        }
        const text = String(page.extract);
        const heads = [...text.matchAll(/^(={2,4}) (.+?) \1$/gm)];
        if (!i.section) {
          const intro = (heads.length ? text.slice(0, heads[0].index) : text).trim();
          return `${page.title} (Wikivoyage)\n\n${intro}${heads.length ? `\n\nSections: ${heads.map((m) => m[2]).join(', ')}. Ask for one with section.` : ''}`;
        }
        const k = heads.findIndex((m) => m[2].toLowerCase() === String(i.section).toLowerCase());
        if (k < 0) return `${page.title} has no section "${i.section}". Its sections: ${heads.map((m) => m[2]).join(', ')}.`;
        const level = heads[k][1].length;
        const end = heads.slice(k + 1).find((m) => m[1].length <= level);
        const body = text.slice(/** @type {number} */ (heads[k].index) + heads[k][0].length, end?.index ?? text.length).trim();
        return `${page.title}: ${heads[k][2]} (Wikivoyage)\n\n${body}`;
      },
    },
  ];
  const off = tools.map((t) => annai.tools.register(t));
  return () => off.forEach((fn) => fn());
}
