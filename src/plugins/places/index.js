import { VERSION } from '../../app/version.js';
import { sunTimes } from '../../core/sun.js';
import { deviceZone, timeIn } from '../../core/time.js';
import { answerJSON } from '../../core/answer.js';
import { overpassChains, KINDS, KIND_NAMES, overpassFilters, osmRow } from '../../core/pack/osm.js';
import { readAppSettings } from '../../core/settings.js';
import { loadPack } from '../../core/pack/read.js';
import { anySignal } from '../../core/signals.js';
import { NOMINATIM_GAP, nominatimTurn, nominatimLanguages } from '../../core/nominatim.js';
import { readingOrder } from '../../core/languages.js';
import { editionsOf, nearUrl, GEOSEARCH_MAX_M, articlesOf, wikiSaid, merged, articleUrl, pageUrl, agentHeader, guideEditions, voyageApi, editionName, wikimediaTurn, ARTICLES, sitelinksUrl, titlesOf, SUMMARIES_PER_ASK } from '../../core/wiki.js';
import { WIKI_EVERY_KM } from '../../core/pack/plan.js';
import { RESULT_MAX } from '../../core/agent/tools.js';
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
 * One to Wikimedia waits for its turn inside the limit (wiki.js wikimediaTurn).
 * @param {any} call @param {string} url @param {RequestInit} init @param {AbortSignal} [late]
 */
async function ask(call, url, init, late = AbortSignal.timeout(ASK_MS.ms)) {
  const where = new URL(url).hostname;
  const ends = anySignal([call.signal, late]);
  try {
    /* en */
    return await wikimediaTurn(url, async () => answerJSON(await call.fetch(url, { ...init, signal: ends }), where === 'nominatim.openstreetmap.org' ? 'Nominatim' : where), ends);
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
 * A guide's parts, one per edition in the reading order: each its title, which Wikivoyage (and, for a part of the offline pack, that), its address
 * (CC BY-SA credits by a link to the article, as Wikipedia's rows do), its introduction and the names of its sections. With section: each part's
 * section of that name (each edition names its own), or a line for the part that has none, with its sections.
 * @param {{ edition: string, title: string, text: string, from?: string }[]} parts from: where a part comes from, after its edition, when not online
 * @param {string | undefined} section
 */
function guideText(parts, section) {
  const read = parts.map((p) => ({
    ...p,
    heads: [...p.text.matchAll(/^(={2,4}) (.+?) \1$/gm)],
    /* en */
    which: `${editionName(p.edition)} Wikivoyage${p.from ? `, ${p.from}` : ''}`,
    address: pageUrl(`${p.edition}.wikivoyage.org`, p.title),
  }));
  const names = (/** @type {RegExpMatchArray[]} */ heads) => heads.map((m) => m[2]).join(', ');
  if (!section) {
    return read.map(({ title, text, heads, which, address }) => {
      const intro = (heads.length ? text.slice(0, heads[0].index) : text).trim();
      /* en */
      return `${title} (${which}) ${address}\n\n${intro}${heads.length ? `\n\nSections: ${names(heads)}. Ask for one with section.` : ''}`;
    }).join('\n\n');
  }
  // Each part: its section, or that it has none (each edition names its own, so one may have what another calls otherwise).
  return read.map(({ title, text, heads, which, address }) => {
    const k = heads.findIndex((m) => m[2].toLowerCase() === String(section).toLowerCase());
    /* en */
    if (k < 0) return `${title} (${which}) has no section "${section}".${heads.length ? ` Its sections: ${names(heads)}.` : ''}`;
    const level = heads[k][1].length;
    const end = heads.slice(k + 1).find((m) => m[1].length <= level);
    const body = text.slice(/** @type {number} */ (heads[k].index) + heads[k][0].length, end?.index ?? text.length).trim();
    /* en */
    return `${title}: ${heads[k][2]} (${which}) ${address}\n\n${body}`;
  }).join('\n\n');
}

/**
 * The line that names the editions whose Wikivoyage didn't answer, so a missing part isn't taken for no guide; '' for none.
 * @param {string[]} editions @param {Map<string, unknown>} failed
 */
function quiet(editions, failed) {
  const hosts = editions.filter((e) => failed.has(e)).map((e) => `${e}.wikivoyage.org`);
  /* en */
  return hosts.length ? `\n${hosts.join(' and ')} didn't answer, so this has no part from ${hosts.length > 1 ? 'them' : 'it'}.` : '';
}

/**
 * The line that names the editions the traveller reads that the offline pack's guides never asked, so an answer from the pack isn't taken for all
 * there is; '' for none. @param {string[]} lacks
 */
function lacking(lacks) {
  /* en */
  return lacks.length ? `\n${lacks.map(editionName).join(' and ')} Wikivoyage ${lacks.length > 1 ? "aren't" : "isn't"} in the offline pack yet; ${lacks.length > 1 ? 'they come' : 'it comes'} with the pack's next download.` : '';
}

/**
 * The line that names what the offline pack's Wikipedia doesn't hold yet of the editions the traveller reads, so an answer from the pack isn't
 * taken for all there is, one edition's telling for every edition's; '' for none. Worded as `lacking`'s. @param {{ editions: string[], more: boolean }} lacks
 */
function lackingArticles({ editions, more }) {
  /* en */
  const said = [
    editions.length ? `${editions.map(editionName).join(' and ')} Wikipedia ${editions.length > 1 ? "aren't" : "isn't"} in the offline pack for every part yet; ${editions.length > 1 ? 'they come' : 'it comes'} with the pack's next download.` : '',
    more ? "Some of its parts don't hold the other editions' summaries yet, so a row may leave out an edition that has its article; they come with the pack's next download." : '',
  ].filter(Boolean);
  return said.length ? `\n${said.join(' ')}` : '';
}

/** A Nominatim place's website and opening hours, from its extratags, as OpenStreetMap has them: empty where it doesn't. @param {any} f @returns {[string, string]} */
function extras(f) {
  const t = f?.extratags && typeof f.extratags === 'object' ? f.extratags : {};
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');
  return [text(t.website) || text(t['contact:website']), text(t.opening_hours)];
}

const round = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
/**
 * The places nearby lists at most, nearest first, apart from Wikipedia's articles (wiki.js ARTICLES), so neither crowds the other out. Its
 * Overpass query (each wider circle only while fewer than ROWS came) and OVERPASS_MS were measured at 40 (24 hourly probes, 2026-11-14 to 16),
 * and OSM_LIMIT is ten times it. That the nearest 40 of a kind are more than a pick needs is a judgment, not a measurement (at the defaults in a
 * city centre most of them are food: 27 of 40 at Tokyo Station, the editions design, 2026-11-20).
 */
const ROWS = 40;
/** A list's nearest n rows, and whether it held more. @param {any[][]} rows @param {number} n @returns {Listed} */
const nearestOf = (rows, n) => {
  const sorted = [...rows].sort((a, b) => a[2] - b[2]);
  return { rows: sorted.slice(0, n), cut: sorted.length > n };
};
/** @typedef {{ rows: any[][], cut: boolean }} Listed  a list's rows as nearby keeps them; cut: it held more, farther */
/** @type {Listed} */
const NONE_LISTED = { rows: [], cut: false };
/**
 * The line naming each list that was cut, as its nearest so many and how far the last of them is; '' for none (docs/lessons.md, 2026-11-17: a
 * capped answer says it was cut). It promises no retry: a smaller circle has the same nearest.
 * @param {Listed} places @param {Listed} articles @param {number} radius
 */
function reach(places, articles, radius) {
  /* en */
  const cut = /** @type {[Listed, string][]} */ ([[places, 'places'], [articles, 'Wikipedia articles']]).filter(([l]) => l.cut && l.rows.length).map(([l, what]) => `the nearest ${l.rows.length} ${what} (out to ${l.rows[l.rows.length - 1][2]} m)`);
  /* en */
  return cut.length ? `\nThese are ${cut.join(' and ')}; farther ones within ${radius} m aren't listed.` : '';
}
/**
 * Said where the offline pack's articles are listed, which are fewer than online (the editions design's measurements, 2026-11-20: at Takayama online
 * gives 59 within 1 km, the pack about 37 within 10 km): a part holds each edition's nearest SUMMARIES_PER_ASK, at each stop and every WIKI_EVERY_KM of the way.
 */
const HOLDS = /* en */ `\nThe offline pack holds each edition's nearest ${SUMMARIES_PER_ASK} Wikipedia articles at each stop and every ${WIKI_EVERY_KM} km of the way, so Wikipedia has more.`;
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
  /** @param {string} url @param {any} call @param {RequestInit} [init] @param {AbortSignal} [late] a time limit already running, shared with other requests */
  const json = (url, call, init = {}, late) => ask(call, url, init, late);
  /** @param {Record<string, any>} app */
  const orderOf = (app) => readingOrder(app, navigator.language);
  /** @param {string} url */
  const named = async (url) => `${url}&accept-language=${encodeURIComponent(nominatimLanguages(orderOf(await readAppSettings(annai.files))))}`;

  /* en */
  const tools = [
    {
      name: 'nearby', group: 'Places',
      description: `Places near a point, nearest first, as TSV: name, kind, distance_m, lat, lng, source, note (website, opening hours). kinds: ${KIND_NAMES.join(', ')} (default sights and food). Up to ${ROWS} places and ${ARTICLES} Wikipedia articles. A Wikipedia article is one row, named in the first of the user's languages whose edition has it, its note holding its address in each of those editions that has it (an answer from the offline pack also gives each edition's short summary, before its address): each edition is written on its own, and can tell the story of a contested place differently. Reads the trip's offline pack first, so it works without a connection along the planned route.`,
      input: { type: 'object', properties: { ...POINT, radius: { type: 'number', minimum: 50, maximum: 20000, description: 'Meters, default 1000.' }, kinds: { type: 'array', items: { enum: KIND_NAMES } } }, required: ['lat', 'lng'] },
      /** @param {{ lat: number, lng: number, radius?: number, kinds?: string[] }} i @param {any} call */
      async run(i, call) {
        const radius = Math.round(Math.min(20000, Math.max(50, i.radius ?? 1000)));
        const kinds = i.kinds?.length ? i.kinds : ['sights', 'food'];
        /** The table: the places kept and the articles kept, nearest first together. @param {Listed} places @param {Listed} articles */
        const table = (places, articles) => tsv(['name', 'kind', 'distance_m', 'lat', 'lng', 'source', 'note'], [...places.rows, ...articles.rows].sort((a, b) => a[2] - b[2]));
        const app = await readAppSettings(annai.files);
        const editions = editionsOf(orderOf(app));
        // The offline pack first (spec §8): where it holds the whole circle, nothing is asked.
        const pack = await loadPack(annai.files, call.trip).catch(() => null);
        /** The pack's places and articles here, each list cut to its own count. @param {import('../../core/pack/read.js').Pack} p */
        const fromPack = (p) => [nearestOf(p.places(i, radius, kinds), ROWS), nearestOf(p.pages(i, radius, editions), ARTICLES)];
        /** Said wherever an article of the answer came from the pack: what a part holds, and what the pack lacks yet of the editions read. @param {import('../../core/pack/read.js').Pack} p */
        const holds = (p) => `${HOLDS}${lackingArticles(p.lacks(editions))}`;
        /**
         * The answer: the table, then its endings. Over a tool result's limit (tools.js RESULT_MAX, which cuts the end, endings and all) the articles
         * farthest away are left out, one at a time, until it fits, and the reach line says how far the rest reach: a pack's rows hold each edition's
         * summary, so a few editions' 50 articles come near the limit (a synthetic pack of 50 articles and 40 places with real summaries, 2026-11-20:
         * about 24,500 characters at ja, zh and en, and at en, de and fr 33,000 with 60% of the articles in each later edition, 43,000 with every one).
         * @param {Listed} places @param {Listed} articles @param {(articles: Listed) => string} endings
         */
        const whole = (places, articles, endings) => {
          let kept = articles;
          for (;;) {
            const out = `${table(places, kept)}${endings(kept)}`;
            if (out.length <= RESULT_MAX || !kept.rows.length) return out;
            kept = { rows: kept.rows.slice(0, -1), cut: true };
          }
        };
        if (pack?.covers(i, radius)) {
          const [places, articles] = fromPack(pack);
          return whole(places, articles, (a) => `\nFrom the offline pack${pack.downloaded}.${holds(pack)}${reach(places, a, radius)}`);
        }
        // Koe's quick reads (the Koe and Kokoro design): the pack only, never the network.
        if (call.offline) {
          if (!pack?.touches(i)) return 'Not in the offline pack: ask Kokoro.';
          const [places, articles] = fromPack(pack);
          return whole(places, articles, (a) => `\nFrom the offline pack${pack.downloaded}, which holds only part of this circle. Kokoro can look further.${holds(pack)}${reach(places, a, radius)}`);
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
        const chains = overpassChains(app);
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
        // Each edition within one ASK_MS, at most three at once (wikimediaTurn; one request a host: the etiquette's "in series" is for bulk clients), each article once,
        // the nearest ARTICLES. An edition that doesn't answer, or answers with an error, has the offline pack's articles of it where the pack reaches.
        const late = AbortSignal.timeout(ASK_MS.ms);
        const headers = agentHeader(VERSION);
        const wikipedia = Promise.allSettled(editions.map(async (e) => {
          const r = await ask(call, nearUrl(e, [round(i.lat), round(i.lng)], Math.min(radius, GEOSEARCH_MAX_M), ARTICLES), { headers }, late);
          const said = wikiSaid(r);
          if (said) throw new Error(`${e}.wikipedia.org said: ${said}.`);
          // Full: the edition may have more within the circle than it sent (counted as it sent them, not as kept).
          return { rows: articlesOf(r, e), full: Array.isArray(r?.query?.pages) && r.query.pages.length >= ARTICLES };
        })).then(async (got) => {
          if (got.every((g) => g.status === 'rejected')) throw /** @type {PromiseRejectedResult} */ (got[0]).reason;
          const quiet = editions.filter((_, k) => got[k].status === 'rejected');
          const answered = got.flatMap((g) => (g.status === 'fulfilled' ? [g.value] : []));
          const packed = quiet.length && pack?.touches(i) ? pack.articles(i, Math.min(radius, GEOSEARCH_MAX_M), quiet).flatMap((a) => [a, ...a.also]) : [];
          const all = merged([...answered.flatMap((g) => g.rows), ...packed], editions).map((a) => ({ a, m: Math.round(meters(i.lat, i.lng, a.lat, a.lng)) })).sort((x, y) => x.m - y.m);
          const kept = all.slice(0, ARTICLES);
          // Which editions have each article kept, and its title there: an edition's list names it only among that edition's own nearest (at Tokyo
          // Station Japanese's lists 36 of the 60 English articles Japanese has: the editions design, 2026-11-20). One Wikidata request, in the same limit.
          /** @type {Map<string, Map<string, string>>} */
          let titles = new Map();
          let unsaid = '';
          const ids = kept.flatMap(({ a }) => (a.id ? [a.id] : []));
          if (editions.length > 1 && ids.length) {
            // The limit may have run out in the lists: Wikidata is then not asked, which is not the same as not answering.
            if (late.aborted) unsaid = "\nWikidata wasn't asked, as the time had run out, so a row may leave out an edition that has its article.";
            else {
              try {
                const r = await ask(call, sitelinksUrl(ids, editions), { headers }, late);
                const said = wikiSaid(r);
                if (said) throw new Error(said);
                titles = titlesOf(r, editions);
              } catch (e) {
                if (call.signal.aborted) throw e;
                unsaid = "\nWikidata didn't answer, so a row may leave out an edition that has its article.";
              }
            }
          }
          // A row's name: the first edition's title that has it, its list's, else Wikidata's; its note, its address in each edition that has it, in the order.
          const rows = kept.map(({ a, m }) => {
            const titleIn = (/** @type {string} */ e) => (e === a.edition ? a.title : a.also.find((x) => x.edition === e)?.title ?? (a.id ? titles.get(a.id)?.get(e) : undefined));
            const has = editions.filter((e) => titleIn(e));
            return [titleIn(has[0]) ?? a.title, 'wikipedia article', m, round(a.lat), round(a.lng), 'wikipedia', has.map((e) => articleUrl(e, /** @type {string} */ (titleIn(e)))).join(' · ')];
          });
          // Named, so a missing edition's articles aren't taken for none.
          const hosts = quiet.map((e) => `${e}.wikipedia.org`).join(' and ');
          const note = !quiet.length ? '' : `\n${hosts} didn't answer, so ${quiet.length > 1 ? 'their' : 'its'} articles ${packed.length ? `come from the offline pack${pack?.downloaded}, where it holds them` : 'are missing from this list'}.`;
          // Wikipedia's geosearch takes GEOSEARCH_MAX_M at most: a wider circle is asked that much of articles, and says so.
          const wide = radius > GEOSEARCH_MAX_M ? `\nWikipedia's articles are asked within ${GEOSEARCH_MAX_M / 1000} km only (its geosearch's limit); farther ones aren't listed.` : '';
          return { rows, cut: all.length > ARTICLES || answered.some((g) => g.full), note: `${note}${unsaid}${wide}`, packed: packed.length > 0 };
        });
        // A service that didn't answer is null; a stopped call is no answer at all. OpenStreetMap is busy when every server asked said so
        // (a 429, or a 5xx: the 502 "Timeout" Overpass sends at once, a 504 "too busy"), known as the last one refuses. Another refusal
        // (the 406 overpass-api.de sends an agent it won't serve) is no answer.
        let busy = false;
        const [got, articles] = await Promise.all([
          overpass.catch((e) => {
            const refusals = e instanceof AggregateError ? e.errors.flatMap((x) => (x instanceof AggregateError ? x.errors : [x])) : [];
            busy = refusals.length > 0 && refusals.every((x) => x?.said?.code === 'status' && (x.said.status === 429 || x.said.status >= 500));
            return null;
          }),
          wikipedia.catch(() => null),
        ]);
        if (call.signal.aborted) throw /* en */ new DOMException('Stopped', 'AbortError');
        /** @type {Listed | null} */
        const osm = got ? nearestOf(got.rows, ROWS) : null;
        // An answer cut at 400 isn't the nearest 40: its own line below says so and how to ask again, so the reach line leaves the places out.
        if (osm && got?.cut) osm.cut = false;
        /** @type {Listed | null} */
        const wiki = articles ? { rows: articles.rows, cut: articles.cut } : null;
        const quiet = articles?.note ?? '';
        // A cut answer says so last, after where its rows came from, and names the circle to ask again with. The circles ran smallest first,
        // each wider one only while fewer than ROWS came, so the one cut is the first of `radii` holding ROWS places or more, and the rows
        // are its places: it is the first circle with ROWS of the rows that came, by the distance each carries (an outline's is to its
        // centre, so a ring-shaped park around the point counts in a circle it doesn't reach: that can name a smaller circle than the one
        // cut, which is still whole. A larger one needs fewer than ROWS nodes in the cut circle and nearly all the rest outlines centred
        // beyond it (Overpass sends every node first): the retry is then cut again, says so, and names a smaller circle). Half of it
        // is the circle before, which held fewer than ROWS and so came whole, and so does any radius under that; for the smallest circle it
        // is a new one, which can be cut again and says so again. Half the radius asked would repeat the answer when an inner circle was
        // cut. What the radius gives is the nearest places within it, few or none (nearby shows OpenStreetMap's nearest ROWS, beside
        // Wikipedia's nearest ARTICLES); the places between it and the first answer's rows stay unknown (docs/limitations.md).
        const cutAt = got?.cut ? radii.find((r) => got.rows.filter((x) => x[2] <= r).length >= ROWS) ?? radius : 0;
        const cut = cutAt ? `\nOpenStreetMap's answer stopped at ${OSM_LIMIT} places, not chosen by distance, so a nearer place may be missing. Ask again with a radius of ${Math.round(cutAt / 2)} m or less for the nearest places within it.` : '';
        // What didn't answer comes from the pack, where the pack reaches (spec §17 rule 2).
        const missing = [osm === null ? 'OpenStreetMap' : '', wiki === null ? 'Wikipedia' : ''].filter(Boolean);
        const why = busy ? `OpenStreetMap is busy${wiki === null ? " and Wikipedia didn't answer" : ''}` : `${missing.join(' and ')} didn't answer`;
        if (missing.length && pack?.touches(i)) {
          const what = missing.length === 2 ? 'these come' : osm === null ? 'its places come' : 'its articles come';
          const [placesHere, articlesHere] = fromPack(pack);
          const places = osm ?? placesHere;
          const pages = wiki ?? articlesHere;
          // Whenever an article of the answer came from the pack: all of them (Wikipedia didn't answer), or an edition's that didn't.
          const held = wiki === null || articles?.packed ? holds(pack) : '';
          return whole(places, pages, (a) => `\n${why}, so ${what} from the offline pack${pack.downloaded}.${quiet}${held}${reach(places, a, radius)}${cut}`);
        }
        if (osm === null && wiki === null) throw new Error(busy ? `${why}. Try again in a moment.` : 'Neither OpenStreetMap nor Wikipedia answered. Try again in a moment.');
        if (!osm) return whole(NONE_LISTED, /** @type {Listed} */ (wiki), (a) => `\n${why}; these are Wikipedia articles only.${quiet}${reach(NONE_LISTED, a, radius)}`);
        return whole(osm, wiki ?? NONE_LISTED, (a) => `${wiki === null ? `\n${why}; these are OpenStreetMap places only.` : `${quiet}${pack && articles?.packed ? holds(pack) : ''}`}${reach(osm, a, radius)}${cut}`);
      },
    },
    {
      name: 'geocode', group: 'Places',
      description: 'Find a place by name or address, as TSV: name, lat, lng, type, website, opening_hours (the last two where OpenStreetMap has them).',
      input: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] },
      /** @param {{ query: string }} i @param {any} call */
      async run(i, call) {
        const found = await nominatim(await named(`${NOMINATIM}/search?q=${encodeURIComponent(i.query)}&format=jsonv2&limit=5&extratags=1`), call);
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
        const f = await nominatim(await named(`${NOMINATIM}/reverse?lat=${i.lat}&lon=${i.lng}&format=jsonv2&zoom=18&extratags=1`), call);
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
      description: "A Wikivoyage travel guide for a place, from English Wikivoyage and from the Wikivoyage of each of the user's languages that has the guide, a part each: its introduction and sections (Understand, See, Do, Eat, Sleep…); ask for one section to read it. Each edition is written on its own, names its own sections (ask for a section by the name its part gives), and can tell the story of a contested place differently. Reads the trip's offline pack first.",
      input: { type: 'object', properties: { place: { type: 'string', minLength: 1 }, section: { type: 'string' } }, required: ['place'] },
      /** @param {{ place: string, section?: string }} i @param {any} call */
      async run(i, call) {
        // English, and each listed language's Wikivoyage, in the reading order.
        const editions = guideEditions(editionsOf(orderOf(await readAppSettings(annai.files))));
        const pack = await loadPack(annai.files, call.trip).catch(() => null);
        // Each edition's part: the offline pack's where it holds one, else read online, else a line says why not.
        const from = `offline pack${pack?.day ? ` of ${pack.day}` : ''}`;
        const inPack = pack ? await pack.guide(i.place, editions).catch(() => []) : [];
        const held = new Map(inPack.filter((p) => p.text).map((p) => [p.edition, { ...p, from }]));
        // What only reading online brings: an edition the guides pass never asked (a language added since, or a pack from before), or one its guide links
        // to whose text didn't come; not one it asked and found no guide in. With no guide of this name in the pack, every edition is read.
        const linked = new Set(inPack.map((p) => p.edition));
        const lacks = pack ? editions.filter((e) => !held.has(e) && (linked.has(e) || !pack.manifest.voyage.includes(e))) : [];
        const need = held.size ? lacks : editions;
        if (!need.length || call.offline) {
          return held.size ? `${guideText(editions.flatMap((e) => held.get(e) ?? []), i.section)}${lacking(lacks)}` : `Not in the offline pack: ask Kokoro.${lacking(lacks)}`;
        }
        /** @type {Map<string, { edition: string, title: string, text: string, links: Map<string, string> }>} the editions' pages that came */
        const got = new Map();
        /** @type {Map<string, unknown>} the editions that didn't answer, with why */
        const failed = new Map();
        /** @type {{ edition: string, title: string, text: string } | null} the first disambiguation page seen */
        let several = null;
        /**
         * An edition's page by title: its text (without, only its titles in the other editions), and those; null for none (missing, a disambiguation
         * page, no text).
         * @param {string} e @param {string} title @param {string} [more] @param {AbortSignal} [late] a time limit shared with other requests @param {boolean} [text]
         */
        const page = async (e, title, more = '', late, text = true) => {
          try {
            const r = await json(`${voyageApi(e)}?action=query&format=json&formatversion=2&origin=*&redirects=1${more}&prop=${text ? 'extracts%7C' : ''}langlinks%7Cpageprops${text ? '&explaintext=1&exsectionformat=wiki' : ''}&lllimit=500&ppprop=disambiguation&titles=${encodeURIComponent(title)}`, call, {}, late);
            const said = wikiSaid(r);
            if (said) throw new Error(`${e}.wikivoyage.org said: ${said}.`);
            const p = /** @type {any} */ (Object.values(r?.query?.pages ?? {})[0]);
            if (!p || p.missing !== undefined || p.invalid !== undefined) return null;
            const body = typeof p.extract === 'string' ? p.extract : '';
            if (text && p.pageprops && typeof p.pageprops === 'object' && 'disambiguation' in p.pageprops) {
              several ??= { edition: e, title: String(p.title ?? title), text: body };
              return null;
            }
            if (text && !body.trim()) return null;
            const links = new Map((Array.isArray(p.langlinks) ? p.langlinks : []).filter((/** @type {any} */ l) => typeof l?.lang === 'string' && typeof l.title === 'string' && l.title).map((/** @type {any} */ l) => [l.lang, l.title]));
            const found = { edition: e, title: String(p.title ?? title), text: body, links };
            if (text) got.set(e, found);
            return found;
          } catch (err) {
            if (call.signal.aborted) throw err;
            failed.set(e, err);
            return null;
          }
        };
        // One time limit for all of it: a dead connection takes ASK_MS, not ASK_MS a request.
        const anchoring = AbortSignal.timeout(ASK_MS.ms);
        /** @type {Map<string, string>} the titles the anchor page gives the editions in */
        let links = new Map();
        /** The anchor's titles didn't come (it failed, or its page is gone): the editions still to read are named as lacking. */
        let noLinks = false;
        if (held.size) {
          // The pack's own part is the anchor, English's where it holds it: only its titles in the other editions are read (the pack has its text).
          const a = /** @type {{ edition: string, title: string }} */ (held.get('en') ?? [...held.values()][0]);
          const r = await page(a.edition, a.title, '', anchoring, false);
          links = r?.links ?? links;
          noLinks = !r;
        } else {
          // English first, by the name, and it decides the place: a name it lists as several places is answered with that list, not another
          // edition's own meaning of it (Georgia is the US state in German, the country in Spanish). Only when it answered that it has no page does
          // the next edition by the name (zh's variants converted: 东京 is 東京) anchor the rest, each after it only on the same answer; one that
          // didn't answer ends it with its error (an absence counts only where the source answered).
          let anchor = await page('en', i.place, '', anchoring);
          for (const e of editions.filter((x) => x !== 'en')) {
            if (anchor || failed.size || /** @type {{ edition: string } | null} */ (several)?.edition === 'en') break;
            anchor = await page(e, i.place, '&converttitles=1', anchoring);
          }
          if (!anchor) {
            // A name that is a disambiguation page: the page, which names the places.
            const d = /** @type {{ edition: string, title: string, text: string } | null} */ (several);
            /* en */
            if (d) return `${i.place} names several places: ${d.title} (${editionName(d.edition)} Wikivoyage) ${pageUrl(`${d.edition}.wikivoyage.org`, d.title)}\n\n${d.text.trim()}${quiet(editions, failed)}`;
            if (failed.size) throw failed.values().next().value;
            const s = await json(`${voyageApi('en')}?action=opensearch&search=${encodeURIComponent(i.place)}&limit=5&namespace=0&format=json&origin=*`, call).catch(() => null);
            const close = Array.isArray(s?.[1]) ? s[1].filter((/** @type {unknown} */ x) => typeof x === 'string') : [];
            /* en */
            return `Wikivoyage has no article called "${i.place}".${close.length ? ` Close ones: ${close.join(', ')}.` : ''}`;
          }
          links = anchor.links;
        }
        // The editions still to read, by the titles the anchor links to, at once (three at a time), in the same time limit.
        await Promise.all(need.filter((e) => !got.has(e) && !failed.has(e) && links.has(e)).map((e) => page(e, /** @type {string} */ (links.get(e)), '', anchoring)));
        return `${guideText(editions.flatMap((e) => held.get(e) ?? got.get(e) ?? []), i.section)}${quiet(editions.filter((e) => !held.has(e)), failed)}${noLinks ? lacking(need) : ''}`;
      },
    },
  ];
  const off = tools.map((t) => annai.tools.register(t));
  return () => off.forEach((fn) => fn());
}
