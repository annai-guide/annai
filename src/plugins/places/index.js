import { VERSION } from '../../app/version.js';
import { sunTimes } from '../../core/sun.js';
import { deviceZone, timeIn } from '../../core/time.js';
import { answerJSON } from '../../core/answer.js';
import { OVERPASS, KINDS, KIND_NAMES, overpassFilters, osmRow } from '../../core/pack/osm.js';
import { loadPack } from '../../core/pack/read.js';

export { KINDS };

export const manifest = {
  id: 'places',
  name: 'Places tools',
  version: VERSION,
  api: 1,
  description: 'nearby, geocode, reverse, weather and guide, from OpenStreetMap, Wikipedia, Nominatim, Open-Meteo and Wikivoyage.',
};

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const CREDIT_OPEN_METEO = 'Weather data by Open-Meteo.com (https://open-meteo.com/, CC BY 4.0)';
/** Nominatim allows one request a second (spec §7.2); the gap is a little more. */
export const NOMINATIM_GAP = { ms: 1100 };

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

/**
 * No forecast without Open-Meteo, but the sun's times, worked out on the phone (spec §11.5), in this
 * phone's time zone (the place's isn't known without the forecast).
 * @param {{ lat: number, lng: number, when?: string }} i @param {unknown} e
 */
function sunOnly(i, e) {
  const tz = deviceZone();
  const day = /^\d{4}-\d{2}-\d{2}/.exec(String(i.when ?? ''))?.[0];
  const noon = day ? Date.parse(`${day}T12:00:00Z`) - (i.lng / 15) * 3_600_000 : Date.now();
  const t = sunTimes(noon, i.lat, i.lng);
  const hm = (/** @type {number | null} */ x) => (x === null ? '' : timeIn(x, tz));
  const head = `Open-Meteo didn't answer (${String(/** @type {any} */ (e)?.message ?? e).replace(/\.$/, '')}), so there is no forecast. Worked out on the phone, in this phone's time zone (${tz}): `;
  if (t.polar === 'day') return `${head}the sun doesn't set that day.`;
  if (t.polar === 'night') return `${head}the sun doesn't rise that day${t.dawn !== null ? `; twilight from ${hm(t.dawn)} to ${hm(t.dusk)}` : ''}.`;
  const golden = t.goldenMorningEnd === null || t.goldenEveningStart === null
    ? 'the sun stays low, golden light all day'
    : `golden hour until ${hm(t.goldenMorningEnd)} in the morning and from ${hm(t.goldenEveningStart)} in the evening`;
  return `${head}sunrise ${hm(t.sunrise)}, sunset ${hm(t.sunset)}, ${golden}.`;
}

/**
 * A guide's introduction and the names of its sections; or one section. Each comes with its article's
 * address, as Wikipedia's rows do: CC BY-SA credits by a link to the article.
 * @param {string} title @param {string} text @param {string | undefined} section @param {string} source
 */
function guideText(title, text, section, source) {
  const heads = [...text.matchAll(/^(={2,4}) (.+?) \1$/gm)];
  const from = `(${source}) https://en.wikivoyage.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  if (!section) {
    const intro = (heads.length ? text.slice(0, heads[0].index) : text).trim();
    return `${title} ${from}\n\n${intro}${heads.length ? `\n\nSections: ${heads.map((m) => m[2]).join(', ')}. Ask for one with section.` : ''}`;
  }
  const k = heads.findIndex((m) => m[2].toLowerCase() === String(section).toLowerCase());
  if (k < 0) return `${title} has no section "${section}". Its sections: ${heads.map((m) => m[2]).join(', ')}.`;
  const level = heads[k][1].length;
  const end = heads.slice(k + 1).find((m) => m[1].length <= level);
  const body = text.slice(/** @type {number} */ (heads[k].index) + heads[k][0].length, end?.index ?? text.length).trim();
  return `${title}: ${heads[k][2]} ${from}\n\n${body}`;
}

const round = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
/** The plain answer for a server's answer that isn't what it should be (never a TypeError: spec §5.5). @param {string} where */
const UNREADABLE = (where) => `${where} sent an answer annai can't read.`;
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
    return answerJSON(res, 'Nominatim');
  };
  /** @param {string} url @param {any} call */
  const json = async (url, call, init = {}) => answerJSON(await call.fetch(url, { signal: call.signal, ...init }), new URL(url).hostname);

  const tools = [
    {
      name: 'nearby', group: 'Places',
      description: `Places near a point, nearest first, as TSV: name, kind, distance_m, lat, lng, source, note. kinds: ${KIND_NAMES.join(', ')} (default sights and food). Reads the trip's offline pack first, so it works without a connection along the planned route.`,
      input: { type: 'object', properties: { ...POINT, radius: { type: 'number', minimum: 50, maximum: 20000, description: 'Meters, default 1000.' }, kinds: { type: 'array', items: { enum: KIND_NAMES } } }, required: ['lat', 'lng'] },
      /** @param {{ lat: number, lng: number, radius?: number, kinds?: string[] }} i @param {any} call */
      async run(i, call) {
        const radius = Math.round(Math.min(20000, Math.max(50, i.radius ?? 1000)));
        const kinds = i.kinds?.length ? i.kinds : ['sights', 'food'];
        const answer = (/** @type {any[][]} */ rows) => tsv(['name', 'kind', 'distance_m', 'lat', 'lng', 'source', 'note'], rows.sort((a, b) => a[2] - b[2]).slice(0, 40));
        // The offline pack first (spec §8): where it holds the whole circle, nothing is asked.
        const pack = await loadPack(annai.files, call.trip).catch(() => null);
        if (pack?.covers(i, radius)) return `${answer([...pack.places(i, radius, kinds), ...pack.pages(i, radius)])}\nFrom the offline pack${pack.downloaded}.`;
        const at = `around:${radius},${round(i.lat)},${round(i.lng)}`;
        // Overpass cuts its output in id order, not by distance, so ask for plenty and keep the nearest 40.
        const query = `[out:json][timeout:20];(${overpassFilters(kinds).map((f) => `nwr(${at})${f};`).join('')});out center tags 400;`;
        /** @type {any[][] | null} */
        let osm = null;
        for (const server of OVERPASS) {
          try {
            const data = await json(server, call, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
            // "runtime error: Query timed out": Overpass stopped early, and its places are cut off: no answer, as the pack takes it.
            if (typeof data?.remark === 'string' && /error/i.test(data.remark)) continue;
            /** @type {any[][]} */
            const rows = [];
            for (const e of Array.isArray(data?.elements) ? data.elements : []) {
              const r = osmRow(e);
              if (r) rows.push([r[1], r[2], Math.round(meters(i.lat, i.lng, r[3], r[4])), r[3], r[4], 'osm', r[5]]);
            }
            osm = rows;
            break;
          } catch (e) {
            if (call.signal.aborted) throw e;
          }
        }
        /** @type {any[][] | null} */
        let wiki = null;
        try {
          const w = await json(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${round(i.lat)}%7C${round(i.lng)}&gsradius=${Math.min(radius, 10000)}&gslimit=30&format=json&origin=*`, call);
          wiki = (Array.isArray(w?.query?.geosearch) ? w.query.geosearch : []).filter((/** @type {any} */ g) => typeof g?.title === 'string')
            .map((/** @type {any} */ g) => [g.title, 'wikipedia article', Math.round(g.dist), round(g.lat), round(g.lon), 'wikipedia', `https://en.wikipedia.org/wiki/${encodeURIComponent(g.title.replace(/ /g, '_'))}`]);
        } catch (e) {
          if (call.signal.aborted) throw e;
        }
        // What didn't answer comes from the pack, where the pack reaches (spec §17 rule 2).
        const missing = [osm === null ? 'OpenStreetMap' : '', wiki === null ? 'Wikipedia' : ''].filter(Boolean);
        if (missing.length && pack?.touches(i)) {
          const what = missing.length === 2 ? 'these come' : osm === null ? 'its places come' : 'its articles come';
          return `${answer([...(osm ?? pack.places(i, radius, kinds)), ...(wiki ?? pack.pages(i, radius))])}\n${missing.join(' and ')} didn't answer, so ${what} from the offline pack${pack.downloaded}.`;
        }
        if (osm === null && wiki === null) throw new Error('Neither OpenStreetMap nor Wikipedia answered. Try again in a moment.');
        const out = answer([...(osm ?? []), ...(wiki ?? [])]);
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
        if (!Array.isArray(found)) throw new Error(UNREADABLE('Nominatim'));
        const places = found.filter((f) => f && typeof f === 'object');
        if (!places.length) return `Nothing found for "${i.query}".`;
        return tsv(['name', 'lat', 'lng', 'type'], places.map((/** @type {any} */ f) => [f.display_name, f.lat, f.lon, `${f.category ?? f.class}/${f.type}`]));
      },
    },
    {
      name: 'reverse', group: 'Places',
      description: 'What is at a point: its name, address and type.',
      input: { type: 'object', properties: POINT, required: ['lat', 'lng'] },
      /** @param {{ lat: number, lng: number }} i @param {any} call */
      async run(i, call) {
        const f = await nominatim(`${NOMINATIM}/reverse?lat=${i.lat}&lon=${i.lng}&format=jsonv2&zoom=18`, call);
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error(UNREADABLE('Nominatim'));
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
        /** @type {any} */
        let w;
        try {
          w = await json(`https://api.open-meteo.com/v1/forecast?latitude=${round(i.lat)}&longitude=${round(i.lng)}`
            + '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m'
            + '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=16', call);
        } catch (e) {
          if (call.signal.aborted) throw e;
          return sunOnly(i, e); // spec §11.5: the sun is worked out on the phone
        }
        if (!w || typeof w !== 'object' || Array.isArray(w)) return sunOnly(i, new Error(UNREADABLE('api.open-meteo.com')));
        const day = i.when ? String(i.when).slice(0, 10) : null;
        const h = w.hourly && typeof w.hourly === 'object' ? w.hourly : {};
        // Only what has the shape of an hour counts (a bad answer is no crash, C2).
        const times = /** @type {string[]} */ ((Array.isArray(h.time) ? h.time : []).map((/** @type {unknown} */ t) => (typeof t === 'string' ? t : '')));
        let idx = times.map((_, k) => k);
        idx = idx.filter((k) => times[k] !== '');
        if (day) idx = idx.filter((k) => times[k].startsWith(day));
        else {
          const nowLocal = times.findIndex((t) => Date.parse(`${t}:00Z`) >= Date.now() + (w.utc_offset_seconds ?? 0) * 1000 - 3_600_000);
          idx = idx.slice(Math.max(0, nowLocal), Math.max(0, nowLocal) + 24);
        }
        if (!idx.length) return `No forecast for ${day ?? 'that time'}: Open-Meteo forecasts 16 days ahead.`;
        const d = w.daily && typeof w.daily === 'object' ? w.daily : {};
        const at = (/** @type {string} */ key, /** @type {number} */ k) => (Array.isArray(d[key]) ? d[key][k] : undefined);
        const di = (Array.isArray(d.time) ? d.time : []).indexOf(times[idx[0]].slice(0, 10));
        // Open-Meteo's licence asks for this credit next to wherever its data shows; the Trace shows this answer.
        const lines = [CREDIT_OPEN_METEO, `Time zone: ${w.timezone}${w.timezone_abbreviation ? ` (${w.timezone_abbreviation})` : ''}`];
        if (di >= 0) {
          lines.push(`${d.time[di]}: ${Math.round(at('temperature_2m_min', di))} to ${Math.round(at('temperature_2m_max', di))} °C, rain chance up to ${at('precipitation_probability_max', di)}%, `
            + `sunrise ${String(at('sunrise', di)).slice(11)}, sunset ${String(at('sunset', di)).slice(11)}`);
        }
        lines.push(tsv(['time', 'temp_c', 'rain_chance_pct', 'rain_mm', 'weather', 'wind_kmh'],
          idx.map((k) => [times[k], h.temperature_2m?.[k], h.precipitation_probability?.[k], h.precipitation?.[k], WEATHER[h.weather_code?.[k]] ?? h.weather_code?.[k], h.wind_speed_10m?.[k]])));
        return lines.join('\n');
      },
    },
    {
      name: 'guide', group: 'Places',
      description: "A Wikivoyage travel guide for a place: its introduction and sections (Understand, See, Do, Eat, Sleep…); ask for one section to read it. Reads the trip's offline pack first.",
      input: { type: 'object', properties: { place: { type: 'string', minLength: 1 }, section: { type: 'string' } }, required: ['place'] },
      /** @param {{ place: string, section?: string }} i @param {any} call */
      async run(i, call) {
        const pack = await loadPack(annai.files, call.trip).catch(() => null);
        const saved = pack ? await pack.guide(i.place).catch(() => null) : null;
        if (pack && saved) return guideText(saved.title, saved.text, i.section, `Wikivoyage, offline pack${pack.day ? ` of ${pack.day}` : ''}`);
        const base = 'https://en.wikivoyage.org/w/api.php';
        const r = await json(`${base}?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=${encodeURIComponent(i.place)}&format=json&origin=*`, call);
        const page = /** @type {any} */ (Object.values(r?.query?.pages ?? {})[0]);
        if (!page || page.missing !== undefined || typeof page.extract !== 'string' || !page.extract) {
          const s = await json(`${base}?action=opensearch&search=${encodeURIComponent(i.place)}&limit=5&namespace=0&format=json&origin=*`, call).catch(() => null);
          const close = Array.isArray(s?.[1]) ? s[1].filter((/** @type {unknown} */ x) => typeof x === 'string') : [];
          return `Wikivoyage has no article called "${i.place}".${close.length ? ` Close ones: ${close.join(', ')}.` : ''}`;
        }
        return guideText(String(page.title ?? i.place), page.extract, i.section, 'Wikivoyage');
      },
    },
  ];
  const off = tools.map((t) => annai.tools.register(t));
  return () => off.forEach((fn) => fn());
}
