import { VERSION } from '../../app/version.js';
import { sunTimes } from '../../core/sun.js';
import { deviceZone, timeIn } from '../../core/time.js';
import { answerJSON } from '../../core/answer.js';
import { overpassChains, KINDS, KIND_NAMES, overpassFilters, osmRow } from '../../core/pack/osm.js';
import { readAppSettings } from '../../core/settings.js';
import { loadPack } from '../../core/pack/read.js';
import { anySignal } from '../../core/signals.js';
import { NOMINATIM_GAP, nominatimTurn } from '../../core/nominatim.js';
import { t as words } from '../../core/l10n.js';

export { KINDS };

export const manifest = {
  id: 'places',
  name: words`Places tools`,
  version: VERSION,
  api: 1,
  description: words`nearby, geocode, reverse, weather and guide, from OpenStreetMap, Wikipedia, Nominatim, Open-Meteo and Wikivoyage.`,
};

// Below, Shiori's words: English (localization design, section 7).

const NOMINATIM = 'https://nominatim.openstreetmap.org';
/* en */
const CREDIT_OPEN_METEO = 'Weather data by Open-Meteo.com (https://open-meteo.com/, CC BY 4.0)';
export { NOMINATIM_GAP };
/**
 * Each request's time limit, so a server that never answers is given up on: Wikipedia, Nominatim, Open-Meteo and Wikivoyage. 25 s,
 * first sized for Overpass (its [timeout:20] plus 5 to connect), which has its own limit now (OVERPASS_MS); Wikipedia answered nearby's
 * real checks from one server in 0.2 to 0.3 s (2026-11-14).
 */
export const ASK_MS = { ms: 25_000 };
/**
 * Overpass's time limit in nearby, one for all its servers together, sized so about 95% of the calls get their places. From 24 hourly
 * probes (2026-11-14, nearby's default query, sights and food within 1000 m, from one server, at four landmarks), replaying this code's
 * rule over each run's own times (overpass-api.de first, the next only after a refusal or a failure, one limit): 22 of 24 calls get places at 50 s
 * and 23 of 24 (96%) at 55 s. The answers those calls would have had came in 27.5 to 51.3 s, the slowest being overpass-api.de's own, so
 * 55 s (51.3 s rounded up to the next 5 s); the 24th call has all three refuse (in 1.7 s, "busy"), which no wait helps. Overpass's own
 * "too busy" 504s (lz4.'s once, at 43.1 s; maps.mail.ru's at 43.8 to 50.5 s) came at 43 to 51 s, so waiting longer gains nothing. 24 of the 25 refusals of the three servers came in half a
 * second (0.49 to 0.61 s, so asking the next in turn costs that much each); the other was lz4.'s 504 at 43.1 s. Today's lighter query,
 * replayed the same way over its own 24 probes (2026-11-15; the probed shape, 300 m then 1000 m): 23 of 24 calls get places, in 27.5 to 51.8 s, so 55 s still holds.
 */
export const OVERPASS_MS = 55_000;

/**
 * A request within its limit (ASK_MS unless given, or a limit already running that several requests share), saying past it who didn't answer.
 * @param {any} call @param {string} url @param {RequestInit} init @param {AbortSignal} [late]
 */
async function ask(call, url, init, late = AbortSignal.timeout(ASK_MS.ms)) {
  const where = new URL(url).hostname;
  try {
    /* en */
    return await answerJSON(await call.fetch(url, { ...init, signal: anySignal([call.signal, late]) }), where === 'nominatim.openstreetmap.org' ? 'Nominatim' : where);
  } catch (e) {
    /* en */
    if (late.aborted && !call.signal.aborted) throw new Error(`${where} didn't answer in time.`);
    throw e;
  }
}

/* en */
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
  /* en */
  const head = `Open-Meteo didn't answer (${String(/** @type {any} */ (e)?.message ?? e).replace(/\.$/, '')}), so there is no forecast. Worked out on the phone, in this phone's time zone (${tz}): `;
  /* en */
  if (t.polar === 'day') return `${head}the sun doesn't set that day.`;
  /* en */
  if (t.polar === 'night') return `${head}the sun doesn't rise that day${t.dawn !== null ? `; twilight from ${hm(t.dawn)} to ${hm(t.dusk)}` : ''}.`;
  /* en */
  const golden = t.goldenMorningEnd === null || t.goldenEveningStart === null
    ? 'the sun stays low, golden light all day'
    : `golden hour until ${hm(t.goldenMorningEnd)} in the morning and from ${hm(t.goldenEveningStart)} in the evening`;
  /* en */
  return `${head}sunrise ${hm(t.sunrise)}, sunset ${hm(t.sunset)}, ${golden}.`;
}

/**
 * A guide's introduction and the names of its sections; or one section. Each comes with its article's
 * address, as Wikipedia's rows do: CC BY-SA credits by a link to the article.
 * @param {string} title @param {string} text @param {string | undefined} section @param {string} source
 */
function guideText(title, text, section, source) {
  const heads = [...text.matchAll(/^(={2,4}) (.+?) \1$/gm)];
  /* en */
  const from = `(${source}) https://en.wikivoyage.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  if (!section) {
    const intro = (heads.length ? text.slice(0, heads[0].index) : text).trim();
    /* en */
    return `${title} ${from}\n\n${intro}${heads.length ? `\n\nSections: ${heads.map((m) => m[2]).join(', ')}. Ask for one with section.` : ''}`;
  }
  const k = heads.findIndex((m) => m[2].toLowerCase() === String(section).toLowerCase());
  /* en */
  if (k < 0) return `${title} has no section "${section}". Its sections: ${heads.map((m) => m[2]).join(', ')}.`;
  const level = heads[k][1].length;
  const end = heads.slice(k + 1).find((m) => m[1].length <= level);
  const body = text.slice(/** @type {number} */ (heads[k].index) + heads[k][0].length, end?.index ?? text.length).trim();
  return `${title}: ${heads[k][2]} ${from}\n\n${body}`;
}

/** A Nominatim place's website and opening hours, from its extratags, as OpenStreetMap has them: empty where it doesn't. @param {any} f @returns {[string, string]} */
function extras(f) {
  const t = f?.extratags && typeof f.extratags === 'object' ? f.extratags : {};
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');
  return [text(t.website) || text(t['contact:website']), text(t.opening_hours)];
}

const round = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
/** The rows nearby gives, nearest first; its Overpass query widens its circle when the small one holds fewer. */
const ROWS = 40;
/** The most elements nearby's Overpass query asks for, ten times the ROWS kept, to bound the download: Overpass cuts there in id order, not by distance. */
const OSM_LIMIT = 400;
/** The plain answer for a server's answer that isn't what it should be (never a TypeError: spec §5.5). @param {string} where */
const UNREADABLE = (where) => /* en */ `${where} sent an answer annai can't read.`;
const POINT = { lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 } };

/** @param {any} annai */
export function activate(annai) {
  const { tsv } = annai.helpers;
  /** Calls Nominatim no faster than once a second, across geocode, reverse and free search's floor (core/nominatim.js). @param {string} url @param {any} call */
  const nominatim = async (url, call) => {
    await nominatimTurn();
    // Nominatim's usage policy asks apps to say who they are. The app's own policy sends no
    // Referer, so this request sends the origin, which its Origin header shows anyway.
    return ask(call, url, { headers: { accept: 'application/json' }, referrerPolicy: 'origin' });
  };
  /** @param {string} url @param {any} call */
  const json = (url, call, init = {}) => ask(call, url, init);

  /* en */
  const tools = [
    {
      name: 'nearby', group: 'Places',
      description: `Places near a point, nearest first, as TSV: name, kind, distance_m, lat, lng, source, note (website, opening hours). kinds: ${KIND_NAMES.join(', ')} (default sights and food). Reads the trip's offline pack first, so it works without a connection along the planned route.`,
      input: { type: 'object', properties: { ...POINT, radius: { type: 'number', minimum: 50, maximum: 20000, description: 'Meters, default 1000.' }, kinds: { type: 'array', items: { enum: KIND_NAMES } } }, required: ['lat', 'lng'] },
      /** @param {{ lat: number, lng: number, radius?: number, kinds?: string[] }} i @param {any} call */
      async run(i, call) {
        const radius = Math.round(Math.min(20000, Math.max(50, i.radius ?? 1000)));
        const kinds = i.kinds?.length ? i.kinds : ['sights', 'food'];
        const answer = (/** @type {any[][]} */ rows) => tsv(['name', 'kind', 'distance_m', 'lat', 'lng', 'source', 'note'], rows.sort((a, b) => a[2] - b[2]).slice(0, ROWS));
        // The offline pack first (spec §8): where it holds the whole circle, nothing is asked.
        const pack = await loadPack(annai.files, call.trip).catch(() => null);
        if (pack?.covers(i, radius)) return `${answer([...pack.places(i, radius, kinds), ...pack.pages(i, radius)])}\nFrom the offline pack${pack.downloaded}.`;
        // Koe's quick reads (the Koe and Kokoro design): the pack only, never the network.
        if (call.offline) {
          if (!pack?.touches(i)) return 'Not in the offline pack: ask Kokoro.';
          return `${answer([...pack.places(i, radius, kinds), ...pack.pages(i, radius)])}\nFrom the offline pack${pack.downloaded}, which holds only part of this circle. Kokoro can look further.`;
        }
        const circle = (/** @type {number} */ r) => `(${overpassFilters(kinds).map((f) => `nwr(around:${r},${round(i.lat)},${round(i.lng)})${f};`).join('')});`;
        // Overpass can't sort by distance, and the OSM_LIMIT cap (400) cuts its output in id order. So circles each half the
        // next (a quarter of its area), from the radius down to the first of 300 m or less, go in one request, smallest first, each wider
        // one only while fewer than ROWS came (`if`): the answer is then a circle uncut, and its nearest ROWS are the true nearest, unless
        // one circle holds fewer than ROWS and the next 400 or more, which is more than ten times as many over a fourfold area (the ring
        // outside more than three times as dense as the circle inside), or the smallest circle itself holds 400 or more. A step of 0.3 (a tenth of the area, as ROWS is a tenth of 400) left no margin: 36 to 39 places
        // spread evenly in one circle are 400 to 433 in the next, and the answer at the Sydney Opera House stayed cut; the saved answers'
        // places grew 10.2 times from 90 to 300 m at Notre-Dame, 5.5 times from 150 to 300 m (counted by centre). 300 m: the smallest
        // circle is then 151 to 300 m for a radius over 300 m, and the 250 m circle held 52, 89 and 77 sights and food at Tokyo Station, Notre-Dame and Times
        // Square (counted by centre, probes of 2026-11-15), so there the answer is that circle whole. maxsize 64 MiB, not the default 512:
        // Overpass's dispatcher starts a query only while what it declares fits in half of what is free (its source, upstream
        // src/template_db/dispatcher.cc, Global_Resource_Planner::probe, read 2026-11-14), so a smaller declaration may start sooner. In
        // 24 hourly probes overpass-api.de refused it 6 times against 10 without, and 23 calls got places within OVERPASS_MS against 20;
        // too few to show the effect (Fisher p 0.36), kept because it costs nothing. It was enough at wide radii (live calls, 2026-11-16: a
        // dense 15 km circle answering 400, and 20 km with all 8 circles run): no "out of memory" remark.
        const radii = [radius];
        while (radii[0] > 300) radii.unshift(Math.round(radii[0] * 0.5));
        const query = `[out:json][timeout:20][maxsize:67108864];${radii.map((r, k) => (k ? `if (count(nwr) < ${ROWS}) {${circle(r)}}` : circle(r))).join('')}out center tags ${OSM_LIMIT};`;
        // One limit, OVERPASS_MS, for all of Overpass, so a call waits that long at most. overpass-api.de's servers are asked in turn, the next
        // only after the one before refuses or fails (an answer costs one request); VK's, while its switch is on, at once beside them
        // (VK's switch is read at each call). The first usable answer stops the others' requests, with a reason the Trace shows (an Error:
        // tracedFetch reads a DOMException AbortError as a stop with none).
        const chains = overpassChains(await readAppSettings(annai.files));
        const limit = AbortSignal.timeout(OVERPASS_MS);
        const won = new AbortController();
        const race = { ...call, signal: anySignal([call.signal, won.signal]) };
        /** @param {string} server */
        const overpassAnswer = async (server) => {
          const data = await ask(race, server, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` }, limit);
          // "runtime error: Query timed out": Overpass stopped early, and its places are cut off: no answer, as the pack takes it.
          if (typeof data?.remark === 'string' && /error/i.test(data.remark)) throw new Error(data.remark);
          /** @type {any[][]} */
          const rows = [];
          for (const e of Array.isArray(data?.elements) ? data.elements : []) {
            const r = osmRow(e);
            // The note: its website (or Wikipedia page), and its opening hours where OpenStreetMap has them.
            if (r) rows.push([r[1], r[2], Math.round(meters(i.lat, i.lng, r[3], r[4])), r[3], r[4], 'osm', [r[5], typeof e.tags?.opening_hours === 'string' ? `hours ${e.tags.opening_hours}` : ''].filter(Boolean).join(' · ')]);
          }
          // Cut: counted in what Overpass sent, not in the rows kept.
          return { rows, cut: Array.isArray(data?.elements) && data.elements.length >= OSM_LIMIT };
        };
        /** One operator's servers, in turn; stops asking once the limit has run out or the call is stopped. @param {string[]} servers */
        const inTurn = async (servers) => {
          /** @type {unknown[]} */
          const errors = [];
          for (const server of servers) {
            if (limit.aborted || race.signal.aborted) break;
            try {
              return await overpassAnswer(server);
            } catch (e) {
              errors.push(e);
            }
          }
          throw new AggregateError(errors, 'no Overpass server answered');
        };
        const overpass = Promise.any(chains.map(inTurn)).finally(() => won.abort(Object.assign(new Error(/* en */ 'Stopped: the other Overpass server answered first.'), { name: 'AbortError' })));
        const wikipedia = json(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${round(i.lat)}%7C${round(i.lng)}&gsradius=${Math.min(radius, 10000)}&gslimit=30&format=json&origin=*`, call)
          .then((w) => (Array.isArray(w?.query?.geosearch) ? w.query.geosearch : []).filter((/** @type {any} */ g) => typeof g?.title === 'string')
            .map((/** @type {any} */ g) => [g.title, 'wikipedia article', Math.round(g.dist), round(g.lat), round(g.lon), 'wikipedia', `https://en.wikipedia.org/wiki/${encodeURIComponent(g.title.replace(/ /g, '_'))}`]));
        // A service that didn't answer is null; a stopped call is no answer at all. OpenStreetMap is busy when every server asked said so
        // (a 429, or a 5xx: the 502 "Timeout" Overpass sends at once, a 504 "too busy"), known as the last one refuses. Another refusal
        // (the 406 overpass-api.de sends an agent it won't serve) is no answer.
        let busy = false;
        const [got, wiki] = await Promise.all([
          overpass.catch((e) => {
            const refusals = e instanceof AggregateError ? e.errors.flatMap((x) => (x instanceof AggregateError ? x.errors : [x])) : [];
            busy = refusals.length > 0 && refusals.every((x) => x?.said?.code === 'status' && (x.said.status === 429 || x.said.status >= 500));
            return null;
          }),
          wikipedia.catch(() => null),
        ]);
        if (call.signal.aborted) throw /* en */ new DOMException('Stopped', 'AbortError');
        const osm = got ? got.rows : null;
        // A cut answer says so last, after where its rows came from, and names the circle to ask again with. The circles ran smallest first,
        // each wider one only while fewer than ROWS came, so the one cut is the first of `radii` holding ROWS places or more, and the rows
        // are its places: it is the first circle with ROWS of the rows that came, by the distance each carries (an outline's is to its
        // centre, so a ring-shaped park around the point counts in a circle it doesn't reach: that can name a smaller circle than the one
        // cut, which is still whole. A larger one needs fewer than ROWS nodes in the cut circle and nearly all the rest outlines centred
        // beyond it, though Overpass sends every node first: the retry is then cut again, says so, and names a smaller circle). Half of it
        // is the circle before, which held fewer than ROWS and so came whole, and so does any radius under that; for the smallest circle it
        // is a new one, which can be cut again and says so again. Half the radius asked would repeat the answer when an inner circle was
        // cut. What the radius gives is the nearest places within it, few or none (nearby shows the nearest ROWS of OpenStreetMap's and
        // Wikipedia's together); the places between it and the first answer's rows stay unknown (docs/limitations.md).
        const cutAt = got?.cut ? radii.find((r) => got.rows.filter((x) => x[2] <= r).length >= ROWS) ?? radius : 0;
        const cut = cutAt ? `\nOpenStreetMap's answer stopped at ${OSM_LIMIT} places, not chosen by distance, so a nearer place may be missing. Ask again with a radius of ${Math.round(cutAt / 2)} m or less for the nearest places within it.` : '';
        // What didn't answer comes from the pack, where the pack reaches (spec §17 rule 2).
        const missing = [osm === null ? 'OpenStreetMap' : '', wiki === null ? 'Wikipedia' : ''].filter(Boolean);
        const why = busy ? `OpenStreetMap is busy${wiki === null ? " and Wikipedia didn't answer" : ''}` : `${missing.join(' and ')} didn't answer`;
        if (missing.length && pack?.touches(i)) {
          const what = missing.length === 2 ? 'these come' : osm === null ? 'its places come' : 'its articles come';
          return `${answer([...(osm ?? pack.places(i, radius, kinds)), ...(wiki ?? pack.pages(i, radius))])}\n${why}, so ${what} from the offline pack${pack.downloaded}.${cut}`;
        }
        if (osm === null && wiki === null) throw new Error(busy ? `${why}. Try again in a moment.` : 'Neither OpenStreetMap nor Wikipedia answered. Try again in a moment.');
        const out = answer([...(osm ?? []), ...(wiki ?? [])]);
        if (!osm) return `${out}\n${why}; these are Wikipedia articles only.`;
        return `${out}${wiki === null ? `\n${why}; these are OpenStreetMap places only.` : ''}${cut}`;
      },
    },
    {
      name: 'geocode', group: 'Places',
      description: 'Find a place by name or address, as TSV: name, lat, lng, type, website, opening_hours (the last two where OpenStreetMap has them).',
      input: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] },
      /** @param {{ query: string }} i @param {any} call */
      async run(i, call) {
        const found = await nominatim(`${NOMINATIM}/search?q=${encodeURIComponent(i.query)}&format=jsonv2&limit=5&extratags=1`, call);
        if (!Array.isArray(found)) throw new Error(UNREADABLE('Nominatim'));
        const places = found.filter((f) => f && typeof f === 'object');
        if (!places.length) return `Nothing found for "${i.query}".`;
        return tsv(['name', 'lat', 'lng', 'type', 'website', 'opening_hours'], places.map((/** @type {any} */ f) => [f.display_name, f.lat, f.lon, `${f.category ?? f.class}/${f.type}`, ...extras(f)]));
      },
    },
    {
      name: 'reverse', group: 'Places',
      description: 'What is at a point: its name, address and type.',
      input: { type: 'object', properties: POINT, required: ['lat', 'lng'] },
      /** @param {{ lat: number, lng: number }} i @param {any} call */
      async run(i, call) {
        const f = await nominatim(`${NOMINATIM}/reverse?lat=${i.lat}&lon=${i.lng}&format=jsonv2&zoom=18&extratags=1`, call);
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error(UNREADABLE('Nominatim'));
        if (f.error) return `Nothing is known at ${i.lat}, ${i.lng}.`;
        const [website, opening_hours] = extras(f);
        return JSON.stringify({ name: f.name ?? '', address: f.display_name ?? '', type: `${f.category ?? f.class}/${f.type}`, ...(website ? { website } : {}), ...(opening_hours ? { opening_hours } : {}) });
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
        if (call.offline) return 'Not in the offline pack: ask Kokoro.';
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
