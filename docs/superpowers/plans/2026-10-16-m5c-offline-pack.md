# Milestone 5c: The Offline Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The offline pack (spec §11.5), the last part of milestone 5:
- **What it holds,** worked out from the trip's plan: OpenStreetMap places around each stop and along the way between stops, Wikipedia summaries of nearby places, and Wikivoyage guides for the trip's destinations.
- **The estimated size is shown before downloading** ("Download (about 420 KB)"). Downloads are polite: one request at a time, a second apart, identified, capped.
- **Everything is stored as files in the trip** (§4.9: everything stored is named), one file per part, so a stopped download goes on from where it was, and an update only fetches what changed.
- **The tools read the pack first** (§8): `nearby` and `guide` answer from it, with no connection where it covers what is asked; live mode names places from it.
- **Kept up to date by itself on Wi-Fi** once the user has downloaded one for the trip ("whenever the phone is on Wi-Fi").
- A panel on the trip's page, a line on Now, end-to-end tests in both browsers, and the device checklist's airplane-mode part.

**Architecture:**
- `src/core/answer.js`: a server's answer as JSON, where anything wrong is a plain error (main's rule: a TypeError or SyntaxError counts as a plugin bug).
- `src/core/pack/osm.js` (pure): the kinds `nearby` knows as Overpass filters, which kinds a place is, a place as a short row. The Places plugin and the pack share it.
- `src/core/pack/plan.js` (pure): the pack's parts from the plan; its fingerprint; the size estimate.
- `src/core/pack/download.js`: downloads the parts and the guides into `/offline/` in the trip; the manifest.
- `src/core/pack/read.js`: the pack as the tools and live mode read it.
- `src/core/pack/keeper.js`: status, one download at a time, progress, updates on Wi-Fi, names for live mode.
- `src/ui/offline-pack.js`: the trip page's panel and Now's line.

**Tech Stack:**
- Native ES modules, no build step, zero runtime dependencies.
- JSDoc types checked by TypeScript 6.0.3.
- Tests: `node:test` (Node 26), and Playwright 1.63.0 in Docker (Chromium as Pixel 7, WebKit as iPhone 15) with `page.route` standing in for the three services.

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`: §11.5 (the offline pack), §8 (the Places tools read the pack first), §11.7 (where coordinates go), §4.9 (everything stored is named), §17 rule 2 (a connection missing: the offline pack still works), §18 (airplane-mode offline use on the device checklist), §20 row 5.

**Not in this plan:**
- **The trip simulation's screen** (milestone 7).
- **Routing:** legs are straight lines (the user's decision); the pack's corridor follows them.
- **Other languages' Wikipedia and Wikivoyage:** the tools use the English ones today; the pack does the same.

## Choices this plan makes (please check them)

1. **The first download is a tap, with the estimate on the button** ("Download (about 420 KB)"). After that, annai keeps that trip's pack up to date by itself on Wi-Fi while annai and the trip are open: when the plan changed, parts are missing, or the pack is a month old, at most once an hour. Safari on iPhone doesn't say when it is on Wi-Fi, so there the panel's Update button does it. *Cost if wrong:* a trip whose pack was never tapped has none; Now says "No offline pack for this trip yet".
2. **What is in it:** OpenStreetMap places of every kind `nearby` knows (fuel, toilets and parking too) within 5 km of each stop and 3 km of the straight line between one stop and the next (legs are straight lines, your decision); Wikipedia summaries within 10 km of each stop and every 15 km on the way; up to 12 Wikivoyage guides. Caps: 100 OpenStreetMap parts, 100 Wikipedia points, 20 MB in all. *Cost if wrong:* a road that strays more than 3 km from the straight line is covered only near the stops.
3. **Wikivoyage is asked about names, never positions.** §11.7 lists OpenStreetMap, Wikipedia and Open-Meteo as the services that get coordinates. Guides are found by checking names against Wikivoyage, 50 a request: the trip's places, the plan's stops, and the Wikipedia articles near them ("Hearst Castle" leads to San Simeon). Tried on the real services for Big Sur: Big Sur, San Simeon, Cambria (California), Central Coast (California). *Cost if wrong:* a destination that none of those names leads to has no guide offline.
4. **Polite downloading:** one request at a time with a second between; `Api-User-Agent: annai/<version> (https://annai.guide)` on Wikipedia and Wikivoyage (a browser can't set User-Agent); the two Overpass servers `nearby` already uses; three failures in a row stop it. A Big Sur pack is about 15 requests.
5. **The tools read the pack first** (§8). `nearby` answers from the pack, with no request, when the pack covers the whole circle asked for, and says "From the offline pack (downloaded 2026-10-16)". Otherwise it asks the services, and the pack fills in for any that don't answer, saying so. `guide` answers from a pack guide by its title, its title without "(California)", or a name that led to it.
6. **The pack's Wikipedia rows in `nearby` carry a summary** (up to 200 characters) before the link; online rows have only the link, as now.
7. **Live mode names places from the pack:** the nearest named sight, park, place to stay or Wikipedia article within 500 m ("near Pfeiffer Beach") in the now block and in catch-up.
8. **The pack's files stay out of Shiori's `list` and `search`, and out of the trip's file list,** unless she asks for `/trip/offline/`: 20 to 200 files would crowd her context. The trip page's panel shows the pack instead.
9. **The estimate uses sizes measured along Big Sur** (1 KB per km of road, 20 KB around a stop, 11 KB per Wikipedia point, 30 KB per guide). Towns are denser, so it can be low there; the panel then shows the real size.
10. **Opening another trip, or removing this one, stops a running download.** What came stays, and "Download the rest" goes on from there.
11. **The pack travels with the trip in every export,** Backups and Shares: it is files in the trip, and compressed it is a fraction of its size. Whoever imports the trip has its pack too. *Cost if wrong:* one line to leave it out of Shares.
12. **A broken server answer is a plain error** that names the server, never a TypeError or SyntaxError, so it can't count against the Places plugin. A small `answerJSON` of its own, rather than the storage plugins' `readAnswer`, whose errors speak of backup places.
13. **The size budget** goes from 1080 KiB to 1120 KiB in Task 1, and is set to what the build needs plus a small margin at the end. You said to raise it as needed and list each raise; this is that list's entry.
14. **Main (milestone 9) was merged before this plan,** so the pack builds on main's `connectionOf` and backups, and the coordinator's end-of-work merge finds little.

## Global Constraints

- All of 5a's and 5b's Global Constraints hold (`docs/superpowers/plans/2026-10-16-m5a-live-core.md`, `docs/superpowers/plans/2026-10-16-m5b-live-on-the-phone.md`).
- **"The offline pack. Before the trip, or whenever the phone is on Wi-Fi, annai downloads data for each destination and along the planned route: Wikivoyage sections; Wikipedia summaries of nearby places; OpenStreetMap points of interest. The estimated size is shown before downloading" (§11.5).**
- **"Places data comes from free services that accept direct browser calls (verified 2026-10-14). The tools read the offline pack first (§11.5)" (§8).**
- **"The Places tools send coordinates to OpenStreetMap, Wikipedia and Open-Meteo. Location otherwise goes only to the user's own model provider" (§11.7).** The pack sends the plan's positions to OpenStreetMap and Wikipedia only; Wikivoyage gets names.
- **"So everything stored must be named… Whatever annai or a plugin keeps… is a file" (§4.9).** The pack is files under `/offline/` in the trip; removing the trip removes it.
- **"a connection | reminders with fallback messages, the offline pack, the plan; wakes queue up" (§17 rule 2).**
- **Usage policies:** no bulk scraping, one request at a time, identified (`Api-User-Agent` for Wikimedia, where browsers allow it), capped.
- **Plugins:** a bad server answer is a plain `Error`, never a `TypeError` or `SyntaxError` (main's quarantine rule, spec §5.5).
- **Rendering:** no `innerHTML` for anything that came from a server or a model; no `style` attribute; links only `https:`.
- **Every file under `src/` is listed in `sw.js` SHELL; `npm run stamp && npm run check` before every commit, chained with `&&`.**
- **E2E in Docker only:** `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test`; delete any `core*` file a WebKit crash leaves.

## Review Focus

1. **The services failing in every way mid-download** (429 and 504, no connection, an HTML page instead of JSON, a cut-off answer, Overpass's "runtime error" remark): each part is noted with what went wrong, three in a row stop the download, nothing crashes, what came stays, and the next tap goes on. Pinned in Task 3.
2. **A plan that changes while a download runs, and a trip opened or removed meanwhile:** the pack shows as outdated afterwards; another trip stops the download. Pinned in Tasks 3 and 5.
3. **A pack edited, cut off or broken on disk:** the tools and live mode treat broken parts as absent and go online; nothing throws. Pinned in Task 4.
4. **Odd plans:** no places, one stop, a flight between stops, stops either side of the date line, 300 stops: the parts and the estimate stay sane and capped. Pinned in Task 2.
5. **A pack that covers only part of what is asked** (a radius larger than the pack's, a point at its edge): `nearby` goes online, and uses the pack's part only when the services don't answer, saying so. Pinned in Task 4.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/answer.js`, `src/core/pack/osm.js`, `src/plugins/places/index.js`, `scripts/size.mjs` | 1 | `answerJSON`; `KINDS`, `KIND_NAMES`, `OVERPASS`, `overpassFilters`, `kindsOf`, `osmRow`; the plugin on them |
| `src/core/pack/plan.js` | 2 | `planStops`, `packPlan`, `planFor`, `estimate`, `likelyGuides`, `guideTitles`, `hashId` |
| `src/core/pack/download.js`, `test/unit/pack-kit.js` | 3 | `downloadPack`, `readManifest`, `pathOf`, `guideFile`; stand-ins for the services |
| `src/core/pack/read.js`, `src/plugins/places/index.js` | 4 | `Pack`, `loadPack`, `toLine`; `nearby` and `guide` read the pack first |
| `src/core/pack/keeper.js`, `src/plugins/files/index.js` | 5 | `PackKeeper`; `list` and `search` leave the pack out |
| `src/ui/offline-pack.js`, `src/ui/screens/trip.js`, `src/ui/screens/now.js`, `src/ui/screens/trace.js`, `src/app/main.js`, `src/ui/shell.js`, `sw.js`, `test/e2e/pack.spec.js`, `docs/testing/device-checklist-m5.md`, `README.md` | 6 | the panel, Now's line, the trace's line; wiring; end to end; checklist |

---

### Task 1: Plain answers, and OpenStreetMap places shared by nearby and the pack

**Files:**
- Create: `src/core/answer.js`, `src/core/pack/osm.js`
- Modify: `src/plugins/places/index.js`, `scripts/size.mjs`, `sw.js` (SHELL)
- Test: `test/unit/answer.test.js`, `test/unit/pack-osm.test.js`, `test/unit/plugin-places.test.js`

**Interfaces:**
- Produces: `answerJSON(res: Response, where: string, max?: number): Promise<any>`, `ANSWER_MAX`; `KINDS`, `KIND_NAMES: string[]`, `UNNAMED: Set<string>`, `OVERPASS: string[]`, `overpassFilters(kinds: string[]): string[]`, `kindsOf(tags): string[]`, `osmRow(e): OsmRow | null` with `OsmRow = [id, name, kind, lat, lng, note, kinds]`.

- [ ] **Step 1: Write the failing tests**

`test/unit/answer.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerJSON } from '../../src/core/answer.js';

test("a server's bad answer is a plain Error that names the server, never a SyntaxError", async () => {
  const plain = (/** @type {RegExp} */ re) => (/** @type {any} */ e) => e.constructor === Error && re.test(e.message);
  await assert.rejects(answerJSON(new Response('<html>busy</html>'), 'overpass-api.de'), plain(/^overpass-api\.de sent an answer annai can't read\.$/));
  await assert.rejects(answerJSON(new Response('', { status: 504 }), 'overpass-api.de'), plain(/^overpass-api\.de answered 504\.$/));
  await assert.rejects(answerJSON(new Response('x'.repeat(20)), 'en.wikipedia.org', 10), plain(/^en\.wikipedia\.org sent more than annai reads/));
  assert.deepEqual(await answerJSON(new Response('{"a":1}'), 'x'), { a: 1 });
});

test('an answer cut off is said so; a stopped request stays stopped', async () => {
  const failing = (/** @type {Error} */ e) => new Response(new ReadableStream({ start(c) { c.error(e); } }));
  await assert.rejects(answerJSON(failing(new TypeError('network error')), 'en.wikipedia.org'), (/** @type {any} */ e) => e.constructor === Error && e.message === "en.wikipedia.org's answer was cut off.");
  await assert.rejects(answerJSON(failing(new DOMException('Stopped', 'AbortError')), 'x'), { name: 'AbortError' });
});
```

`test/unit/pack-osm.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overpassFilters, kindsOf, osmRow, KIND_NAMES } from '../../src/core/pack/osm.js';

test('the Overpass filters nearby has always sent: whole values, and a name where one is needed', () => {
  assert.deepEqual(overpassFilters(['sights', 'toilets', 'parks']), [
    '[tourism~"^(attraction|viewpoint|museum|gallery|artwork|zoo|aquarium)$"][name]', '[historic][name]', '[natural~"^(waterfall|peak|beach|cave_entrance|arch)$"][name]',
    '[amenity=toilets]', '[leisure~"^(park|nature_reserve)$"][name]', '[boundary=national_park][name]']);
  assert.deepEqual(KIND_NAMES, ['sights', 'food', 'fuel', 'parking', 'toilets', 'lodging', 'shops', 'parks']);
  assert.deepEqual(overpassFilters(['nonsense']), []);
});

test('which kinds a place is, by its tags', () => {
  assert.deepEqual(kindsOf({ tourism: 'viewpoint', name: 'McWay Falls Overlook' }), ['sights']);
  assert.deepEqual(kindsOf({ tourism: 'viewpoint' }), []); // a sight needs a name
  assert.deepEqual(kindsOf({ amenity: 'toilets' }), ['toilets']);
  assert.deepEqual(kindsOf({ amenity: 'public_bookcase', name: 'Little Library' }), []);
  assert.deepEqual(kindsOf({ tourism: 'camp_site', leisure: 'park', name: 'Pfeiffer Big Sur' }), ['lodging', 'parks']);
});

test('a place as a row: id, name, kind, position, note and kinds; nothing without a position', () => {
  assert.deepEqual(osmRow({ type: 'way', id: 45, center: { lat: 36.158051, lon: -121.67199 }, tags: { name: 'McWay Falls', natural: 'waterfall', wikipedia: 'en:McWay Falls' } }),
    ['w45', 'McWay Falls', 'waterfall', 36.1581, -121.672, 'en:McWay Falls', 'sights']);
  assert.equal(osmRow({ type: 'node', id: 7, lat: 35.685, lon: -121.168, tags: { historic: 'castle', name: 'Hearst Castle' } })?.[2], 'historic castle');
  assert.deepEqual(osmRow({ type: 'node', id: 8, lat: 36.1, lon: -121.6, tags: { amenity: 'fuel', brand: 'Chevron' } })?.slice(1, 3), ['Chevron', 'fuel']);
  assert.equal(osmRow({ type: 'node', id: 9, tags: { name: 'Nowhere' } }), null);
  assert.equal(osmRow(null), null);
  assert.equal(osmRow({ lat: '36', lon: -121 }), null);
});
```

Add to `test/unit/plugin-places.test.js` (at the end):
```js
test("a server's answer annai can't read is the tool's plain answer, not a bug in the plugin", async () => {
  const { run } = await setup();
  await assert.rejects(run('geocode', { query: 'Big Sur' }, () => new Response('<html>Bad gateway</html>')),
    (/** @type {any} */ e) => e.constructor === Error && /^Nominatim sent an answer annai can't read\.$/.test(e.message));
  await assert.rejects(run('guide', { place: 'Big Sur' }, () => new Response('{"query":')),
    (/** @type {any} */ e) => e.constructor === Error && /^en\.wikivoyage\.org sent an answer annai can't read\.$/.test(e.message));
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/answer.test.js test/unit/pack-osm.test.js test/unit/plugin-places.test.js`
Expected: FAIL: the two new modules can't be found; the places test fails with a SyntaxError.

- [ ] **Step 3: Write the code**

`src/core/answer.js`:
```js
/** The most of a server's answer annai reads as JSON: 8 MiB. */
export const ANSWER_MAX = 8 * 1024 * 1024;

/**
 * A server's answer, as JSON. Whatever is wrong with it (an error status, cut off, too large, not
 * JSON) is the server's doing, so it is a plain Error that says so: a TypeError or SyntaxError would
 * count as a bug in the plugin that asked (spec §5.5), and three of those turn the plugin off.
 * A stopped request stays an AbortError.
 * @param {Response} res @param {string} where the server, as the user knows it ("en.wikipedia.org")
 * @param {number} [max] the most characters read
 * @returns {Promise<any>}
 */
export async function answerJSON(res, where, max = ANSWER_MAX) {
  if (!res.ok) throw new Error(`${where} answered ${res.status}.`);
  /** @type {string} */
  let text;
  try {
    text = await res.text();
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
    throw new Error(`${where}'s answer was cut off.`);
  }
  if (text.length > max) throw new Error(`${where} sent more than annai reads (${Math.round(max / 1_048_576)} MB).`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${where} sent an answer annai can't read.`);
  }
}
```

`src/core/pack/osm.js`:
```js
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
```

In `src/plugins/places/index.js`:
- Imports: add `import { answerJSON } from '../../core/answer.js';` and `import { OVERPASS, KINDS, KIND_NAMES, overpassFilters, osmRow } from '../../core/pack/osm.js';`; keep `export { KINDS };` so the plugin's exports stay.
- Remove the plugin's own `OVERPASS`, `KINDS` and `UNNAMED` constants.
- `nominatim`: replace `if (!res.ok) throw new Error(\`Nominatim answered ${res.status}.\`);\n    return res.json();` with `return answerJSON(res, 'Nominatim');`.
- `json`: becomes
```js
  /** @param {string} url @param {any} call */
  const json = async (url, call, init = {}) => answerJSON(await call.fetch(url, { signal: call.signal, ...init }), new URL(url).hostname);
```
- `nearby`'s description uses `KIND_NAMES.join(', ')` and its input `enum: KIND_NAMES`; its filters are `overpassFilters(i.kinds?.length ? i.kinds : ['sights', 'food'])`; its loop over elements becomes:
```js
            for (const e of Array.isArray(data?.elements) ? data.elements : []) {
              const r = osmRow(e);
              if (r) rows.push([r[1], r[2], Math.round(meters(i.lat, i.lng, r[3], r[4])), r[3], r[4], 'osm', r[5]]);
            }
```
- `guide`: `Object.values(r.query?.pages ?? {})` becomes `Object.values(r?.query?.pages ?? {})`.

`scripts/size.mjs`: the budget becomes `1120 * 1024`, with the comment ending `…; 1080 with both; 1120 for the offline pack`.

`sw.js` SHELL: add `'/src/core/answer.js',` and `'/src/core/pack/osm.js',` in path order.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/answer.test.js test/unit/pack-osm.test.js test/unit/plugin-places.test.js`
Expected: PASS, the places plugin's earlier tests too (the filters are the same text).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A src/core/answer.js src/core/pack/osm.js src/plugins/places/index.js scripts/size.mjs sw.js test/unit/answer.test.js test/unit/pack-osm.test.js test/unit/plugin-places.test.js && git commit -m "A server's broken answer is a plain error, never a crash in the Places plugin; OpenStreetMap places as rows the offline pack shares (spec §11.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 2: What the pack holds, from the plan

**Files:**
- Create: `src/core/pack/plan.js`
- Modify: `sw.js` (SHELL)
- Test: `test/unit/pack-plan.test.js`

**Interfaces:**
- Consumes: `meters` (`src/core/live/geo.js`); `PLAN_FILE`, `LEG_MAX_KM` (`src/core/plan.js`).
- Produces: `planStops(items): Stop[]`; `packPlan({ trip, items }): PackPlan`; `planFor(ws, scope): Promise<PackPlan>`; `estimate(parts, guides): number`; `likelyGuides(plan): number`; `guideTitles(name): string[]`; `hashId(text): string`; constants `STOP_M` 5000, `CORRIDOR_M` 3000, `STRETCH_KM` 40, `WIKI_EVERY_KM` 15, `WIKI_APART_KM` 7, `WIKI_RADIUS_M` 10000, `MAX_OSM` 100, `MAX_WIKI` 100, `MAX_GUIDES` 12, `SIZES`.
- Types: `Part = OsmPart | WikiPart`; `OsmPart = { id: 'o…', kind: 'osm', label, points: [lat, lng][], radius, km }`; `WikiPart = { id: 'w…', kind: 'wikipedia', label, at: [lat, lng] }`; `PackPlan = { key, stops, parts, names, cut }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/pack-plan.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { packPlan, planStops, planFor, estimate, likelyGuides, guideTitles, hashId, STRETCH_KM, MAX_OSM, MAX_WIKI } from '../../src/core/pack/plan.js';
import { meters } from '../../src/core/live/geo.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/live/big-sur.json', import.meta.url), 'utf8'));
const bigSur = Object.entries(fixture.plan).map(([id, item]) => ({ path: `/plan/${id}.json`, item }));
const pt = (/** @type {[number, number]} */ p) => ({ lat: p[0], lng: p[1] });

test('Big Sur: OpenStreetMap around each stop and along each leg, Wikipedia at each stop and on the way, and the names to look up', () => {
  const plan = packPlan({ trip: { places: ['Big Sur'] }, items: bigSur });
  assert.deepEqual(plan.stops.map((s) => s.name), ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  const osm = plan.parts.filter((p) => p.kind === 'osm');
  const around = osm.filter((p) => p.km === 0);
  const along = osm.filter((p) => p.km > 0);
  assert.equal(around.length, 5);
  assert.deepEqual(around.map((p) => [p.radius, p.label]).slice(0, 2), [[5000, 'around Bixby Creek Bridge'], [5000, 'around Nepenthe']]);
  assert.equal(along.length, 5); // McWay Falls to Hearst Castle, about 70 km, in two stretches
  for (const p of along) assert.ok(p.radius === 3000 && p.points.length === 2 && p.km <= STRETCH_KM, p.label);
  assert.deepEqual(along[0].points, [[36.3715, -121.9017], [36.2213, -121.7567]]);
  const wiki = plan.parts.filter((p) => p.kind === 'wikipedia');
  assert.equal(wiki.length, 9);
  for (const a of wiki) for (const b of wiki) if (a !== b) assert.ok(meters(pt(a.at), pt(b.at)) >= 7000, `${a.label} / ${b.label}`);
  assert.deepEqual(plan.names, ['Big Sur', 'Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  assert.equal(plan.cut, 0);
  assert.equal(new Set(plan.parts.map((p) => p.id)).size, plan.parts.length);
});

test('the same plan gives the same parts and key; moving a stop changes the key and only the parts near it', () => {
  const a = packPlan({ trip: null, items: bigSur });
  const b = packPlan({ trip: null, items: structuredClone(bigSur) });
  assert.equal(a.key, b.key);
  const moved = structuredClone(bigSur);
  const cambria = moved.find((x) => x.path === '/plan/cambria.json');
  if (cambria) cambria.item.place.lat += 0.02;
  const c = packPlan({ trip: null, items: moved });
  assert.notEqual(c.key, a.key);
  const ids = new Set(c.parts.map((p) => p.id));
  assert.ok(a.parts.filter((p) => p.label.includes('Bixby')).every((p) => ids.has(p.id)));
  assert.notEqual(packPlan({ trip: { places: ['Monterey'] }, items: bigSur }).key, a.key); // the names count too
});

test('a flight is no leg, the same place twice in a row is one stop, and items without a place or a time', () => {
  const items = [
    { path: '/plan/sfo.json', item: { title: 'Fly out', start: { at: '2026-11-25T08:00:00Z' }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 } } },
    { path: '/plan/sfo2.json', item: { title: 'Lounge', start: { at: '2026-11-25T09:00:00Z' }, place: { name: 'SFO lounge', lat: 37.6215, lng: -122.3791 } } },
    { path: '/plan/hnd.json', item: { title: 'Land', start: { at: '2026-11-26T15:00:00Z' }, place: { name: 'Haneda', lat: 35.5494, lng: 139.7798 } } },
    { path: '/plan/note.json', item: { title: 'Pack', start: { at: '2026-11-24T08:00:00Z' } } },
    { path: '/plan/odd.json', item: { title: 'Odd', place: { name: 'Nowhere', lat: 'x', lng: 1 } } },
    { path: '/plan/later.json', item: { title: 'Some day', place: { name: 'Asakusa', lat: 35.7148, lng: 139.7967 } } },
  ];
  const plan = packPlan({ trip: { places: [' ', 3, 'Tokyo'] }, items });
  assert.deepEqual(plan.stops.map((s) => s.name), ['SFO', 'Haneda', 'Asakusa']);
  assert.equal(plan.parts.filter((p) => p.kind === 'osm' && p.km > 0).length, 1); // Haneda to Asakusa only
  assert.deepEqual(plan.names, ['Tokyo', 'SFO', 'Haneda', 'Asakusa']);
  assert.deepEqual(planStops([]), []);
  assert.deepEqual(packPlan({ trip: null, items: [] }).parts, []);
});

test('stops either side of the date line are joined the short way', () => {
  const items = [
    { path: '/plan/a.json', item: { title: 'A', start: { at: '2026-11-25T08:00:00Z' }, place: { name: 'Taveuni East', lat: -16.85, lng: 179.95 } } },
    { path: '/plan/b.json', item: { title: 'B', start: { at: '2026-11-25T10:00:00Z' }, place: { name: 'Taveuni West', lat: -16.95, lng: -179.95 } } },
  ];
  const along = packPlan({ trip: null, items }).parts.filter((p) => p.kind === 'osm' && p.km > 0);
  assert.equal(along.length, 1);
  assert.ok(along[0].kind === 'osm' && along[0].km < 30, 'about 23 km, not around the world');
});

test('a very long plan is capped, and says how much was left out', () => {
  const items = Array.from({ length: 300 }, (_, k) => ({ path: `/plan/s${k}.json`, item: { title: `Stop ${k}`, start: { at: new Date(Date.UTC(2026, 10, 1) + k * 3_600_000).toISOString() }, place: { name: `Stop ${k}`, lat: 30 + k * 0.3, lng: -100 } } }));
  const plan = packPlan({ trip: null, items });
  assert.ok(plan.parts.filter((p) => p.kind === 'osm').length <= MAX_OSM);
  assert.ok(plan.parts.filter((p) => p.kind === 'wikipedia').length <= MAX_WIKI);
  assert.ok(plan.cut > 0);
});

test('the estimate shown before downloading: about 0.4 MB for Big Sur', () => {
  const plan = packPlan({ trip: { places: ['Big Sur'] }, items: bigSur });
  assert.equal(likelyGuides(plan), 3);
  const n = estimate(plan.parts, likelyGuides(plan));
  assert.ok(n > 300 * 1024 && n < 600 * 1024, String(n));
  assert.equal(estimate([], 0), 0);
});

test('the Wikivoyage titles a name may be under', () => {
  assert.deepEqual(guideTitles('Cambria, California'), ['Cambria, California', 'Cambria (California)']);
  assert.deepEqual(guideTitles('  Big   Sur '), ['Big Sur']);
  assert.deepEqual(guideTitles('  '), []);
});

test('fingerprints are short, steady and different', () => {
  assert.equal(hashId('osm 5000 36.3715,-121.9017'), hashId('osm 5000 36.3715,-121.9017'));
  assert.notEqual(hashId('a'), hashId('b'));
  assert.match(hashId('anything'), /^[0-9a-z]{1,11}$/);
});

test("planFor reads the trip's places and its plan folder, leaving out broken files and subfolders", async () => {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await ws.patch(trip, '/trip.json', { places: ['Big Sur'] }, { author: 'user' });
  await ws.write(trip, '/plan/nepenthe.json', fixture.plan.nepenthe, { author: 'user' });
  await ws.write(trip, '/plan/old/mcway.json', fixture.plan.mcway, { author: 'user' });
  await ws.write(trip, '/plan/broken.json', '{"title":', { author: 'user', type: 'text/plain' });
  const plan = await planFor(ws, trip);
  assert.deepEqual(plan.stops.map((s) => s.name), ['Nepenthe']);
  assert.deepEqual(plan.names, ['Big Sur', 'Nepenthe']);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/pack-plan.test.js`
Expected: FAIL: `src/core/pack/plan.js` can't be found.

- [ ] **Step 3: Write the code**

`src/core/pack/plan.js`:
```js
import { meters } from '../live/geo.js';
import { PLAN_FILE, LEG_MAX_KM } from '../plan.js';

/**
 * What a trip's offline pack holds (spec §11.5), worked out from its plan. The stops are the plan's
 * items with a place, in the order of their times. Around each stop, OpenStreetMap places within
 * 5 km; between one stop and the next, within 3 km of the straight line (legs are straight lines:
 * there is no routing); Wikipedia summaries at each stop and every 15 km on the way. Wikivoyage
 * guides are found when downloading, from the names here and Wikipedia's (choice 3).
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {[lat: number, lng: number]} LatLng
 * @typedef {{ id: string, kind: 'osm', label: string, points: LatLng[], radius: number, km: number }} OsmPart
 *   points: one (around a stop) or two (a stretch of a leg); km: the stretch's length, 0 around a stop
 * @typedef {{ id: string, kind: 'wikipedia', label: string, at: LatLng }} WikiPart
 * @typedef {OsmPart | WikiPart} Part
 * @typedef {{ name: string, lat: number, lng: number }} Stop
 * @typedef {{ key: string, stops: Stop[], parts: Part[], names: string[], cut: number }} PackPlan
 *   key: changes when the parts or the names do; names: what to look for in Wikivoyage, the trip's
 *   places first; cut: stops and legs left out, all or in part, because the pack would be too large
 */

export const STOP_M = 5000;
export const CORRIDOR_M = 3000;
export const STRETCH_KM = 40;
export const WIKI_EVERY_KM = 15;
export const WIKI_APART_KM = 7;
export const WIKI_RADIUS_M = 10000; // the largest Wikipedia searches
export const MAX_OSM = 100;
export const MAX_WIKI = 100;
export const MAX_GUIDES = 12;

/** Rough sizes, from real answers along Big Sur in October 2026, for the estimate shown before downloading (choice 9). */
export const SIZES = Object.freeze({ osmPerKm: 1024, osmStop: 20 * 1024, wikipedia: 11 * 1024, guide: 30 * 1024 });

const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
const pt = (/** @type {LatLng} */ p) => ({ lat: p[0], lng: p[1] });
const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);

/** A short fingerprint of some text (cyrb53), in digits and letters. @param {string} s */
export function hashId(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The point a fraction of the way from a to b in a straight line, the short way across the date line. @param {Stop} a @param {Stop} b @param {number} f @returns {LatLng} */
function between(a, b, f) {
  let d = b.lng - a.lng;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  let lng = a.lng + d * f;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return [r4(a.lat + (b.lat - a.lat) * f), r4(lng)];
}

/** @param {LatLng[]} points @param {number} radius @param {number} km @param {string} label @returns {OsmPart} */
function osmPart(points, radius, km, label) {
  return { id: `o${hashId(`osm ${radius} ${points.map((p) => p.join(',')).join(' ')}`)}`, kind: 'osm', label, points, radius, km };
}

/** @param {LatLng} at @param {string} label @returns {WikiPart} */
function wikiPart(at, label) {
  return { id: `w${hashId(`wikipedia ${at.join(',')}`)}`, kind: 'wikipedia', label, at };
}

/**
 * The plan's stops in time order (items without a time last), the same place twice in a row once.
 * @param {{ path: string, item: any }[]} items @returns {Stop[]}
 */
export function planStops(items) {
  const placed = items.filter(({ item }) => item && typeof item === 'object' && isNum(item.place?.lat) && isNum(item.place?.lng)
    && Math.abs(item.place.lat) <= 90 && Math.abs(item.place.lng) <= 180);
  const at = (/** @type {any} */ it) => {
    const t = Date.parse(it.start?.at ?? '');
    return Number.isFinite(t) ? t : Infinity;
  };
  placed.sort((a, b) => at(a.item) - at(b.item) || a.path.localeCompare(b.path));
  /** @type {Stop[]} */
  const out = [];
  for (const { item } of placed) {
    const s = { name: String(item.place.name ?? item.title ?? '').trim() || 'a plan stop', lat: item.place.lat, lng: item.place.lng };
    const last = out[out.length - 1];
    if (!last || meters(last, s) >= 50) out.push(s);
  }
  return out;
}

/** @param {{ trip: any, items: { path: string, item: any }[] }} o @returns {PackPlan} */
export function packPlan({ trip, items }) {
  const stops = planStops(items);
  /** @type {OsmPart[]} */
  const osm = [];
  /** @type {WikiPart[]} */
  const wiki = [];
  let cut = 0;
  const wikiNear = (/** @type {LatLng} */ p) => wiki.some((w) => meters(pt(w.at), pt(p)) < WIKI_APART_KM * 1000);
  // The stops first, so a long plan keeps them all before the way between them.
  for (const s of stops) {
    const here = /** @type {LatLng} */ ([r4(s.lat), r4(s.lng)]);
    const osmDone = osm.some((o) => o.km === 0 && meters(pt(o.points[0]), s) < 1000);
    const wikiDone = wikiNear(here);
    if ((!osmDone && osm.length >= MAX_OSM) || (!wikiDone && wiki.length >= MAX_WIKI)) cut++;
    if (!osmDone && osm.length < MAX_OSM) osm.push(osmPart([here], STOP_M, 0, `around ${s.name}`));
    if (!wikiDone && wiki.length < MAX_WIKI) wiki.push(wikiPart(here, `near ${s.name}`));
  }
  for (let i = 0; i + 1 < stops.length; i++) {
    const [a, b] = [stops[i], stops[i + 1]];
    const km = meters(a, b) / 1000;
    if (km > LEG_MAX_KM || km * 1000 <= STOP_M) continue; // a flight; or the stops' own circles reach
    const label = `between ${a.name} and ${b.name}`;
    const n = Math.ceil(km / STRETCH_KM);
    let whole = true;
    for (let k = 0; k < n; k++) {
      const part = osmPart([between(a, b, k / n), between(a, b, (k + 1) / n)], CORRIDOR_M, Math.round((km / n) * 10) / 10, label);
      if (osm.some((o) => o.id === part.id)) continue;
      if (osm.length >= MAX_OSM) whole = false;
      else osm.push(part);
    }
    for (let d = WIKI_EVERY_KM; d < km - WIKI_APART_KM / 2; d += WIKI_EVERY_KM) {
      const p = between(a, b, d / km);
      if (wikiNear(p)) continue;
      if (wiki.length >= MAX_WIKI) whole = false;
      else wiki.push(wikiPart(p, label));
    }
    if (!whole) cut++;
  }
  const places = (Array.isArray(trip?.places) ? trip.places : []).filter((/** @type {unknown} */ x) => typeof x === 'string' && x.trim());
  const names = [...new Set([...places.map((/** @type {string} */ x) => x.trim().replace(/\s+/g, ' ')), ...stops.map((s) => s.name)])];
  const parts = [...osm, ...wiki];
  return { key: hashId(JSON.stringify([parts.map((p) => p.id), names])), stops, parts, names, cut };
}

/** A trip's pack plan, from its files. @param {Workspace} ws @param {string} scope @returns {Promise<PackPlan>} */
export async function planFor(ws, scope) {
  const trip = await ws.readJSON(scope, '/trip.json').catch(() => null);
  /** @type {{ path: string, item: any }[]} */
  const items = [];
  for (const f of await ws.list(scope, '/plan/')) {
    if (!PLAN_FILE.test(f.path)) continue;
    const item = await ws.readJSON(scope, f.path).catch(() => null);
    if (item) items.push({ path: f.path, item });
  }
  return packPlan({ trip, items });
}

/** About how many bytes some parts and guides take (spec §11.5: shown before downloading). @param {Part[]} parts @param {number} guides */
export function estimate(parts, guides) {
  let n = guides * SIZES.guide;
  for (const p of parts) n += p.kind === 'wikipedia' ? SIZES.wikipedia : p.km > 0 ? p.km * SIZES.osmPerKm : SIZES.osmStop;
  return Math.round(n);
}

/** About how many guides a plan's pack gets: one for every two names it looks for, at most 12. @param {PackPlan} plan */
export function likelyGuides(plan) {
  return Math.min(MAX_GUIDES, Math.ceil(plan.names.length / 2));
}

/** The Wikivoyage titles a name may be under: as it is, and "Cambria (California)" for "Cambria, California". @param {string} name */
export function guideTitles(name) {
  const n = String(name).trim().replace(/\s+/g, ' ');
  if (!n) return [];
  const m = /^(.+?), ([^,]+)$/.exec(n);
  return m ? [n, `${m[1]} (${m[2]})`] : [n];
}
```

`sw.js` SHELL: add `'/src/core/pack/plan.js',` in path order.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/pack-plan.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A src/core/pack/plan.js sw.js test/unit/pack-plan.test.js && git commit -m "What the offline pack holds, from the plan: OpenStreetMap around each stop and along the way, Wikipedia every 15 km, the names to look up in Wikivoyage, and the size estimate (spec §11.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 3: Downloading the pack into the trip

**Files:**
- Create: `src/core/pack/download.js`, `test/unit/pack-kit.js`
- Modify: `sw.js` (SHELL)
- Test: `test/unit/pack-download.test.js`

**Interfaces:**
- Consumes: Task 1's `answerJSON`, `OVERPASS`, `overpassFilters`, `osmRow`, `KIND_NAMES`; Task 2's `planFor`, `guideTitles`, `hashId`, `MAX_GUIDES`, `WIKI_RADIUS_M`, `Part`.
- Produces: `downloadPack({ ws, scope, fetch, version, signal?, onProgress?, gapMs?, now?, maxBytes? }): Promise<Manifest>`; `readManifest(ws, scope): Promise<Manifest | null>`; `pathOf(part): string`; `guideFile(title): { id, path }`; `DIR` '/offline/', `MANIFEST` '/offline/pack.json', `GAP_MS` 1000, `MAX_BYTES` 20 MiB, `STALE_MS` 30 days.
- Types: `Manifest = { format: 1, key, at, files: PackFile[], guides: Guide[], failed: { label, why }[], full, stopped, bytes }`; `PackFile = { id, kind: 'osm' | 'wikipedia' | 'wikivoyage', path, bytes, items, at }` (at: when that part was downloaded, so an unchanged re-download still counts as fresh); `Guide = { title, asked: string[], path }`; `Progress = { done, total, label }`.
- Files: `/offline/osm/<id>.json` = `{ area: { points, radius }, rows: OsmRow[] }`; `/offline/wikipedia/<id>.json` = `{ at, radius, pages: [title, lat, lng, summary][] }`; `/offline/wikivoyage/<id>.json` = `{ title, text }`. Compact JSON.
- Test kit (`test/unit/pack-kit.js`), used by Tasks 3 to 5: `packTrip(): Promise<{ store, ws, trip }>` (Bixby and Nepenthe stops); `STOPS`; `services(o?)` → `{ fetch, asked }` standing in for Overpass, Wikipedia and Wikivoyage; `fakeAgent(target)`.

- [ ] **Step 1: Write the test kit and the failing tests**

`test/unit/pack-kit.js`:
```js
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip } from '../../src/core/scopes.js';

/** Two Big Sur stops, 21 km apart. */
export const STOPS = Object.freeze({
  bixby: { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: '2026-11-27T17:45:00Z', tz: 'America/Los_Angeles' }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } },
  nepenthe: { id: 'nepenthe', title: 'Lunch at Nepenthe', fixed: true, start: { at: '2026-11-27T20:00:00Z', tz: 'America/Los_Angeles' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } },
});

/** A trip with the two stops. */
export async function packTrip() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await ws.write(trip, '/plan/bixby.json', STOPS.bixby, { author: 'user' });
  await ws.write(trip, '/plan/nepenthe.json', STOPS.nepenthe, { author: 'user' });
  return { store, ws, trip };
}

const near = (/** @type {string} */ text, /** @type {number} */ lat) => text.includes(String(lat));

/** What Overpass has around Bixby and Nepenthe, and along the coast between them. @param {string} url @param {any} init */
export function overpass(url, init) {
  const q = decodeURIComponent(String(init?.body ?? '')).replace(/\+/g, ' ');
  if (q.includes('around:3000')) return { elements: [{ type: 'node', id: 3, lat: 36.3066, lon: -121.9017, tags: { name: 'Point Sur Lighthouse', historic: 'lighthouse' } }] };
  if (near(q, 36.3715)) {
    return { elements: [{ type: 'node', id: 1, lat: 36.3712, lon: -121.902, tags: { name: 'Bixby Bridge Vista Point', tourism: 'viewpoint' } }, { type: 'node', id: 2, lat: 36.372, lon: -121.9015, tags: { amenity: 'toilets' } }] };
  }
  return { elements: [{ type: 'way', id: 4, center: { lat: 36.2203, lon: -121.7612 }, tags: { name: 'Nepenthe', amenity: 'restaurant', website: 'https://www.nepenthe.com/' } }, { type: 'node', id: 5, lat: 36.2381, lon: -121.8162, tags: { name: 'Pfeiffer Beach', natural: 'beach' } }] };
}

/** What Wikipedia has near Bixby and near Nepenthe. @param {string} url */
export function wikipedia(url) {
  const page = (/** @type {string} */ title, /** @type {number} */ lat, /** @type {number} */ lon, /** @type {string} */ extract) => ({ title, coordinates: [{ lat, lon }], extract });
  if (url.includes('ggscoord=36.3715')) {
    return { query: { pages: [page('Bixby Creek Bridge', 36.3715, -121.9017, 'Bixby Creek Bridge is a reinforced concrete open-spandrel arch bridge in Big Sur.'), page('Big Sur', 36.2704, -121.8081, 'Big Sur is a rugged and mountainous section of the Central Coast of California.')] } };
  }
  return { query: { pages: [page('Nepenthe (restaurant)', 36.2203, -121.7612, 'Nepenthe is a restaurant in Big Sur.'), page('Cambria, California', 36.21, -121.75, 'Cambria is a seaside town.'), page('Big Sur', 36.2704, -121.8081, 'Big Sur is a rugged section of coast.')] } };
}

const GUIDES = /** @type {Record<string, string>} */ ({
  'Big Sur': 'Big Sur is a region.\n\n== Understand ==\nRugged coast.\n\n== Eat ==\nNepenthe.',
  'Cambria (California)': 'Cambria is a town.\n\n== See ==\nMoonstone Beach.',
});

/** Wikivoyage: which titles it has (Hearst Castle leads to San Simeon), and their text. @param {string} url */
export function wikivoyage(url) {
  const u = new URL(url);
  const titles = (u.searchParams.get('titles') ?? '').split('|');
  if (u.searchParams.get('prop') === 'pageprops') {
    return { query: { redirects: [{ from: 'Hearst Castle', to: 'San Simeon' }], pages: titles.map((t) => (GUIDES[t] ? { title: t } : t === 'Nepenthe' ? { title: t, pageprops: { disambiguation: '' } } : { title: t, missing: true })) } };
  }
  return { query: { pages: [{ title: titles[0], extract: GUIDES[titles[0]] ?? '' }] } };
}

/**
 * Stand-ins for Overpass, Wikipedia and Wikivoyage, answering as they do; each request is noted.
 * @param {{ overpass?: (url: string, init: any) => any, wikipedia?: (url: string, init: any) => any, wikivoyage?: (url: string, init: any) => any }} [o]
 */
export function services(o = {}) {
  /** @type {{ url: string, init: any, at: number }[]} */
  const asked = [];
  /** @param {string} url @param {any} [init] */
  const fetch = async (url, init = {}) => {
    asked.push({ url, init, at: Date.now() });
    const host = new URL(url).hostname;
    const answer = host.includes('overpass') ? o.overpass ?? overpass : host === 'en.wikipedia.org' ? o.wikipedia ?? wikipedia : host === 'en.wikivoyage.org' ? o.wikivoyage ?? wikivoyage : () => new Response('', { status: 404 });
    const a = await answer(url, init);
    return a instanceof Response ? a : new Response(JSON.stringify(a));
  };
  return { fetch, asked };
}

/** Shiori as the pack keeper sees her: the open trip, and an "open" event. @param {string | null} target */
export function fakeAgent(target) {
  /** @type {Set<() => void>} */
  const fns = new Set();
  return {
    target,
    on(/** @type {string} */ kind, /** @type {() => void} */ fn) {
      if (kind === 'open') fns.add(fn);
      return () => fns.delete(fn);
    },
    open(/** @type {string | null} */ t) {
      this.target = t;
      for (const fn of fns) fn();
    },
  };
}
```

`test/unit/pack-download.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPack, readManifest, MANIFEST, pathOf, STALE_MS } from '../../src/core/pack/download.js';
import { planFor } from '../../src/core/pack/plan.js';
import { packTrip, services, STOPS } from './pack-kit.js';

const V = '9.9.9';
const files = async (/** @type {any} */ ws, /** @type {string} */ trip) => (await ws.list(trip, '/offline/')).map((/** @type {any} */ f) => f.path).sort();
const body = (/** @type {any} */ a) => decodeURIComponent(String(a.init.body ?? '')).replace(/\+/g, ' ');

test('each part once, a moment apart, into named files; the guides by name only', async () => {
  const { ws, trip } = await packTrip();
  const { fetch, asked } = services();
  /** @type {any[]} */
  const progress = [];
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, gapMs: 20, onProgress: (p) => progress.push(p) });
  const plan = await planFor(ws, trip);
  assert.equal(plan.parts.length, 5); // around both stops and along the way; Wikipedia at both stops
  assert.equal(m.key, plan.key);
  assert.deepEqual(m.failed, []);
  assert.equal(m.stopped, false);
  assert.equal(m.full, false);
  const paths = await files(ws, trip);
  assert.equal(paths.filter((p) => p.startsWith('/offline/osm/')).length, 3);
  assert.equal(paths.filter((p) => p.startsWith('/offline/wikipedia/')).length, 2);
  assert.equal(paths.filter((p) => p.startsWith('/offline/wikivoyage/')).length, 2);
  assert.ok(paths.includes(MANIFEST));
  // In the order of their names: the plan's, then Wikipedia's nearest first (Cambria's stand-in article is 1.4 km from Nepenthe).
  assert.deepEqual(m.guides.map((g) => [g.title, g.asked]), [['Cambria (California)', ['Cambria, California']], ['Big Sur', ['Big Sur']]]);
  assert.equal(m.files.length, 7);
  assert.equal(m.bytes, m.files.reduce((n, f) => n + f.bytes, 0));
  const overpassAsked = asked.filter((a) => a.url.includes('overpass')).map(body);
  assert.ok(overpassAsked.some((q) => q.includes('nwr(around:5000,36.3715,-121.9017)[amenity=toilets];')));
  assert.ok(overpassAsked.some((q) => q.includes('around:3000,36.3715,-121.9017,36.2213,-121.7567')));
  assert.ok(overpassAsked.every((q) => q.startsWith('data=[out:json][timeout:60];') && q.endsWith('out center tags 3000;')));
  for (const a of asked.filter((x) => x.url.startsWith('https://en.'))) assert.equal(a.init.headers['Api-User-Agent'], 'annai/9.9.9 (https://annai.guide)');
  for (const a of asked.filter((x) => x.url.includes('wikivoyage'))) assert.doesNotMatch(a.url, /coord|36\.\d|121\.\d/); // names, never a position (§11.7)
  for (let k = 1; k < asked.length; k++) assert.ok(asked[k].at - asked[k - 1].at >= 15, 'one request at a time, apart');
  const osm = JSON.parse(String(await ws.readText(trip, pathOf(plan.parts[0]))));
  assert.deepEqual(osm.area, { points: [[36.3715, -121.9017]], radius: 5000 });
  assert.deepEqual(osm.rows[0], ['n1', 'Bixby Bridge Vista Point', 'viewpoint', 36.3712, -121.902, '', 'sights']);
  assert.equal(progress.at(-1).done, progress.at(-1).total - 1);
  assert.deepEqual(await readManifest(ws, trip), m);
});

test('the next download asks only for what changed, and drops what the plan no longer needs', async () => {
  const { ws, trip } = await packTrip();
  await downloadPack({ ws, scope: trip, ...services(), version: V, gapMs: 0 });
  const before = await files(ws, trip);
  const again = services();
  await downloadPack({ ws, scope: trip, fetch: again.fetch, version: V, gapMs: 0 });
  assert.deepEqual(again.asked.filter((a) => !a.url.includes('wikivoyage')), []);
  assert.deepEqual(await files(ws, trip), before);
  await ws.write(trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { name: 'Nepenthe', lat: 36.1, lng: -121.65 } }, { author: 'user' });
  const moved = services();
  const m = await downloadPack({ ws, scope: trip, fetch: moved.fetch, version: V, gapMs: 0 });
  assert.equal(moved.asked.filter((a) => a.url.includes('overpass')).length, 2); // around the new Nepenthe, and the way to it
  const after = await files(ws, trip);
  const plan = await planFor(ws, trip);
  assert.deepEqual(after.filter((p) => !p.includes('wikivoyage') && p !== MANIFEST), plan.parts.map(pathOf).sort());
  assert.equal(m.key, plan.key);
});

test("the second Overpass server when the first fails; a part that fails is noted, and the rest goes on", async () => {
  const { ws, trip } = await packTrip();
  const { fetch, asked } = services({
    overpass: (url, init) => {
      if (url.includes('overpass-api.de')) return new Response('', { status: 429 });
      return body({ init }).includes('around:3000') ? new Response('', { status: 504 }) : { elements: [] };
    },
  });
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, gapMs: 0 });
  assert.ok(asked.some((a) => a.url.includes('overpass.private.coffee')));
  assert.deepEqual(m.failed, [{ label: 'OpenStreetMap between Bixby Creek Bridge and Nepenthe', why: "OpenStreetMap didn't answer (overpass.private.coffee answered 504)." }]);
  assert.equal(m.stopped, false);
  assert.equal(m.files.filter((f) => f.kind === 'osm').length, 2);
  assert.equal(m.guides.length, 2);
});

test('three failures in a row stop it: no connection, broken answers and refusals are failures that say so, never crashes', async () => {
  const { ws, trip } = await packTrip();
  const offline = services({ overpass: () => { throw new Error("annai couldn't reach overpass-api.de. Is the device offline?"); } });
  const m = await downloadPack({ ws, scope: trip, fetch: offline.fetch, version: V, gapMs: 0 });
  assert.equal(m.failed.length, 3);
  assert.equal(m.stopped, true);
  assert.match(m.failed[0].why, /^OpenStreetMap didn't answer \(annai couldn't reach overpass-api\.de\. Is the device offline\?\)\.$/);
  assert.equal(offline.asked.filter((a) => a.url.includes('wikipedia')).length, 0);
  const broken = services({
    overpass: () => new Response('<html>Overpass is busy</html>'),
    wikipedia: () => ({ error: { code: 'maxlag', info: 'Waiting for a database server' } }),
  });
  const b = await downloadPack({ ws, scope: trip, fetch: broken.fetch, version: V, gapMs: 0 });
  assert.match(b.failed[0].why, /overpass\.private\.coffee sent an answer annai can't read/);
  const remark = services({ overpass: () => ({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 61 seconds.' }) });
  const r = await downloadPack({ ws, scope: trip, fetch: remark.fetch, version: V, gapMs: 0 });
  assert.match(r.failed[0].why, /stopped early: runtime error: Query timed out/);
  const wiki = services({ overpass: () => ({ elements: [] }), wikipedia: () => ({ error: { code: 'maxlag', info: 'Waiting for a database server' } }) });
  const w = await downloadPack({ ws, scope: trip, fetch: wiki.fetch, version: V, gapMs: 0 });
  assert.deepEqual(w.failed.map((f) => f.why), ['Wikipedia said: Waiting for a database server.', 'Wikipedia said: Waiting for a database server.']);
});

test('stopping keeps what came, and the next download goes on from there', async () => {
  const { ws, trip } = await packTrip();
  const abort = new AbortController();
  const first = services();
  const m = await downloadPack({ ws, scope: trip, fetch: first.fetch, version: V, gapMs: 10, signal: abort.signal, onProgress: (p) => { if (p.done === 2) abort.abort(); } });
  assert.equal(m.stopped, true);
  assert.equal(m.files.length, 2);
  assert.equal(m.failed.length, 0);
  const next = services();
  const n = await downloadPack({ ws, scope: trip, fetch: next.fetch, version: V, gapMs: 0 });
  assert.equal(next.asked.filter((a) => !a.url.includes('wikivoyage')).length, 3);
  assert.equal(n.files.length, 7);
  assert.equal(n.stopped, false);
});

test('the pack stops at its size limit and says so', async () => {
  const { ws, trip } = await packTrip();
  const m = await downloadPack({ ws, scope: trip, ...services(), version: V, gapMs: 0, maxBytes: 600 });
  assert.equal(m.full, true);
  assert.ok(m.bytes <= 600);
  assert.ok(m.files.length < 7);
});

test('parts a month old are downloaded again, and kept as they were when that fails', async () => {
  const { ws, trip } = await packTrip();
  await downloadPack({ ws, scope: trip, ...services(), version: V, gapMs: 0 });
  const later = () => Date.now() + STALE_MS + 86_400_000;
  const fresh = services();
  await downloadPack({ ws, scope: trip, fetch: fresh.fetch, version: V, gapMs: 0, now: later });
  assert.equal(fresh.asked.filter((a) => a.url.includes('overpass')).length, 3);
  const before = await files(ws, trip);
  const down = services({ overpass: () => new Response('', { status: 503 }), wikipedia: () => new Response('', { status: 503 }) });
  const m = await downloadPack({ ws, scope: trip, fetch: down.fetch, version: V, gapMs: 0, now: () => later() + STALE_MS + 86_400_000 });
  assert.equal(m.stopped, true);
  assert.deepEqual(await files(ws, trip), before);
  assert.equal(m.files.length, 7);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/pack-download.test.js`
Expected: FAIL: `src/core/pack/download.js` can't be found.

- [ ] **Step 3: Write the code**

`src/core/pack/download.js`:
```js
import { OVERPASS, overpassFilters, osmRow, KIND_NAMES } from './osm.js';
import { planFor, guideTitles, hashId, MAX_GUIDES, WIKI_RADIUS_M } from './plan.js';
import { answerJSON } from '../answer.js';
import { meters } from '../live/geo.js';
import { StorageFullError } from '../errors.js';

/**
 * Downloads a trip's offline pack (spec §11.5), one request at a time with a second between them:
 * the parts its plan needs that the pack doesn't have, or has from more than a month ago, then the
 * Wikivoyage guides for the names the trip, the plan and the Wikipedia summaries give. Parts the plan
 * no longer needs go. Each part is a file in the trip (§4.9: everything stored is named), so a
 * download that stops keeps what it got and the next goes on from there. Positions go only to
 * OpenStreetMap and Wikipedia (§11.7); Wikivoyage is asked about names, as the guide tool asks it.
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {import('./plan.js').Part} Part
 * @typedef {import('./plan.js').PackPlan} PackPlan
 * @typedef {{ id: string, kind: 'osm' | 'wikipedia' | 'wikivoyage', path: string, bytes: number, items: number, at: number }} PackFile
 *   items: places, summaries, or 1 for a guide; at: when it was downloaded (ms). Not the file's own time: a
 *   download that brings the same bytes leaves the file as it was.
 * @typedef {{ title: string, asked: string[], path: string }} Guide
 *   asked: the names that led to it ("Hearst Castle" leads to San Simeon)
 * @typedef {{ format: 1, key: string, at: string, files: PackFile[], guides: Guide[],
 *   failed: { label: string, why: string }[], full: boolean, stopped: boolean, bytes: number }} Manifest
 *   key: the plan's when it was downloaded; full: it reached its 20 MB; stopped: it was stopped, or gave up
 * @typedef {{ done: number, total: number, label: string }} Progress
 * @typedef {(url: string, init: RequestInit, where: string) => Promise<any>} Ask
 */

export const DIR = '/offline/';
export const MANIFEST = '/offline/pack.json';
const WIKIPEDIA = 'https://en.wikipedia.org/w/api.php';
const WIKIVOYAGE = 'https://en.wikivoyage.org/w/api.php';
/** A second between requests: no service is asked twice at once (their usage policies). */
export const GAP_MS = 1000;
/** The most a pack takes on the phone. */
export const MAX_BYTES = 20 * 1024 * 1024;
/** A part older than this is downloaded again. */
export const STALE_MS = 30 * 86_400_000;
/** After this many failures in a row the download stops: the connection or the services are down. */
const GIVE_UP = 3;
/** Overpass gives at most this many places for each part. */
const OSM_LIMIT = 3000;
const TITLES_PER_ASK = 50;
const MAX_NAMES = 200;
const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);
const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;

/** Where a part is kept. @param {Part} p */
export const pathOf = (p) => `${DIR}${p.kind}/${p.id}.json`;
/** Where a guide is kept. @param {string} title */
export function guideFile(title) {
  const id = `g${hashId(title)}`;
  return { id, path: `${DIR}wikivoyage/${id}.json` };
}

/** The pack's manifest, or null when there is none or it is broken. @param {Workspace} ws @param {string} scope @returns {Promise<Manifest | null>} */
export async function readManifest(ws, scope) {
  const m = await ws.readJSON(scope, MANIFEST).catch(() => null);
  if (!m || typeof m !== 'object' || m.format !== 1 || !Array.isArray(m.files) || !Array.isArray(m.guides) || !Array.isArray(m.failed)) return null;
  return {
    format: 1, key: String(m.key ?? ''), at: String(m.at ?? ''),
    files: m.files.filter((f) => typeof f?.path === 'string' && typeof f.id === 'string' && ['osm', 'wikipedia', 'wikivoyage'].includes(f.kind))
      .map((f) => ({ id: f.id, kind: f.kind, path: f.path, bytes: Number(f.bytes) || 0, items: Number(f.items) || 0, at: Number(f.at) || 0 })),
    guides: m.guides.filter((g) => typeof g?.title === 'string' && typeof g.path === 'string')
      .map((g) => ({ title: g.title, asked: Array.isArray(g.asked) ? g.asked.filter((a) => typeof a === 'string') : [], path: g.path })),
    failed: m.failed.filter((f) => typeof f?.label === 'string').map((f) => ({ label: f.label, why: String(f.why ?? '') })),
    full: m.full === true, stopped: m.stopped === true, bytes: Number(m.bytes) || 0,
  };
}

/** Waits, or stops waiting when the download is stopped. @param {number} ms @param {AbortSignal} signal */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve(undefined);
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve(undefined);
    }, { once: true });
  });
}

/**
 * @param {{ ws: Workspace, scope: string, fetch: Fetch, version: string, signal?: AbortSignal,
 *   onProgress?: (p: Progress) => void, gapMs?: number, now?: () => number, maxBytes?: number }} o
 * @returns {Promise<Manifest>}
 */
export async function downloadPack(o) {
  const { ws, scope } = o;
  const now = o.now ?? Date.now;
  const signal = o.signal ?? new AbortController().signal;
  const max = o.maxBytes ?? MAX_BYTES;
  const plan = await planFor(ws, scope);
  const old = await readManifest(ws, scope);
  const have = new Map((await ws.list(scope, DIR)).map((f) => [f.path, f]));
  const prev = new Map((old?.files ?? []).map((f) => [f.path, f]));
  const fresh = (/** @type {string} */ path) => {
    const f = have.get(path);
    return f !== undefined && now() - (prev.get(path)?.at || f.modified) <= STALE_MS;
  };
  /** @type {Map<string, PackFile>} */
  const files = new Map();
  /** @type {{ label: string, why: string }[]} */
  const failed = [];
  let bytes = 0;
  let full = false;
  let fails = 0;
  let asked = 0;
  const headers = { 'Api-User-Agent': `annai/${o.version} (https://annai.guide)` };
  /** @type {Ask} */
  const ask = async (url, init, where) => {
    if (asked++) await pause(o.gapMs ?? GAP_MS, signal);
    if (signal.aborted) throw new DOMException('The download was stopped.', 'AbortError');
    return answerJSON(await o.fetch(url, { ...init, signal }), where);
  };
  /** What the pack already has stays, as it is. @param {Omit<PackFile, 'bytes' | 'at' | 'items'>} f @param {number} [count] */
  const keepOld = (f, count) => {
    const size = have.get(f.path)?.size ?? 0;
    files.set(f.path, { ...f, bytes: size, items: count ?? prev.get(f.path)?.items ?? 0, at: prev.get(f.path)?.at || have.get(f.path)?.modified || 0 });
    bytes += size;
  };
  /** Writes a file, unless the pack would pass its limit. @param {Omit<PackFile, 'bytes' | 'at'>} f @param {unknown} content */
  const save = async (f, content) => {
    const text = JSON.stringify(content);
    const size = new TextEncoder().encode(text).byteLength;
    if (bytes + size > max) {
      full = true;
      return false;
    }
    await ws.write(scope, f.path, text, { author: 'system' });
    files.set(f.path, { ...f, bytes: size, at: now() });
    bytes += size;
    return true;
  };
  const over = () => signal.aborted || fails >= GIVE_UP || full;
  /** @param {string} label @param {unknown} e */
  const failure = (label, e) => {
    if (e instanceof StorageFullError) throw e; // the panel's storage-full card says what to do
    fails++;
    failed.push({ label, why: String(/** @type {any} */ (e)?.message ?? e) });
  };

  for (const p of plan.parts) if (fresh(pathOf(p))) keepOld({ id: p.id, kind: p.kind, path: pathOf(p) });
  const todo = plan.parts.filter((p) => !files.has(pathOf(p)));
  let total = todo.length + 1; // and finding the guides
  let done = 0;
  const progress = (/** @type {string} */ label) => o.onProgress?.({ done, total, label });
  for (const p of todo) {
    if (over()) break;
    const label = `${p.kind === 'osm' ? 'OpenStreetMap' : 'Wikipedia'} ${p.label}`;
    progress(label);
    try {
      const got = p.kind === 'osm' ? await osm(p, ask) : await wikipedia(p, ask, headers);
      if (!(await save({ id: p.id, kind: p.kind, path: pathOf(p), items: got.count }, got.content))) break;
      fails = 0;
    } catch (e) {
      if (signal.aborted) break;
      failure(label, e);
    }
    done++;
  }
  // A part this download didn't get stays as it was, however old.
  for (const p of todo) if (!files.has(pathOf(p)) && have.has(pathOf(p))) keepOld({ id: p.id, kind: p.kind, path: pathOf(p) });

  /** @type {Guide[]} */
  const guides = [];
  let guidesDone = false;
  if (!over()) {
    progress('Wikivoyage');
    try {
      const found = await findGuides(await namesFor(ws, scope, plan, files), ask, headers);
      done++;
      total += found.length;
      for (const g of found) {
        if (over()) break;
        const { id, path } = guideFile(g.title);
        if (fresh(path)) keepOld({ id, kind: 'wikivoyage', path }, 1);
        else {
          progress(`Wikivoyage: ${g.title}`);
          try {
            if (!(await save({ id, kind: 'wikivoyage', path, items: 1 }, { title: g.title, text: await article(g.title, ask, headers) }))) break;
            fails = 0;
          } catch (e) {
            if (signal.aborted) break;
            failure(`Wikivoyage: ${g.title}`, e);
            if (have.has(path)) keepOld({ id, kind: 'wikivoyage', path }, 1);
          }
        }
        if (files.has(path)) guides.push({ ...g, path });
        done++;
      }
      guidesDone = !over();
    } catch (e) {
      if (!signal.aborted) failure('Wikivoyage', e);
    }
  }
  if (!guidesDone) {
    // The guides this download didn't get to stay as they were.
    for (const g of old?.guides ?? []) {
      if (guides.some((x) => x.path === g.path) || !have.has(g.path)) continue;
      if (!files.has(g.path)) keepOld({ id: g.path.slice(DIR.length + 'wikivoyage/'.length, -'.json'.length), kind: 'wikivoyage', path: g.path }, 1);
      guides.push(g);
    }
  }
  /** @type {Manifest} */
  const manifest = {
    format: 1, key: plan.key, at: new Date(now()).toISOString(), files: [...files.values()], guides, failed,
    full, stopped: signal.aborted || fails >= GIVE_UP, bytes,
  };
  const gone = [...have.keys()].filter((path) => path !== MANIFEST && !files.has(path));
  await ws.writeMany(scope, [...gone.map((path) => ({ path, content: null })), { path: MANIFEST, content: JSON.stringify(manifest) }], { author: 'system' });
  return manifest;
}

/** OpenStreetMap places for a part: every kind nearby knows, from the first Overpass server that answers. @param {import('./plan.js').OsmPart} p @param {Ask} ask */
async function osm(p, ask) {
  const around = `around:${p.radius},${p.points.map((q) => q.join(',')).join(',')}`;
  const query = `[out:json][timeout:60];(${overpassFilters(KIND_NAMES).map((f) => `nwr(${around})${f};`).join('')});out center tags ${OSM_LIMIT};`;
  /** @type {unknown} */
  let last = null;
  for (const server of OVERPASS) {
    const host = new URL(server).hostname;
    try {
      const data = await ask(server, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` }, host);
      if (!Array.isArray(data?.elements)) throw new Error(`${host} sent an answer annai can't read.`);
      if (typeof data.remark === 'string' && /error/i.test(data.remark)) throw new Error(`${host} stopped early: ${data.remark.trim().replace(/\.$/, '')}.`);
      const seen = new Set();
      /** @type {import('./osm.js').OsmRow[]} */
      const rows = [];
      for (const e of data.elements) {
        const r = osmRow(e);
        if (r && !seen.has(r[0])) {
          seen.add(r[0]);
          rows.push(r);
        }
      }
      return { count: rows.length, content: { area: { points: p.points, radius: p.radius }, rows } };
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      last = e;
    }
  }
  throw new Error(`OpenStreetMap didn't answer (${String(/** @type {any} */ (last)?.message ?? last).replace(/\.$/, '')}).`);
}

/** Wikipedia's summaries near a part's point. @param {import('./plan.js').WikiPart} p @param {Ask} ask @param {Record<string, string>} headers */
async function wikipedia(p, ask, headers) {
  const [lat, lng] = p.at;
  const r = await ask(`${WIKIPEDIA}?action=query&format=json&formatversion=2&origin=*&generator=geosearch&ggscoord=${lat}%7C${lng}&ggsradius=${WIKI_RADIUS_M}&ggslimit=20`
    + '&prop=extracts%7Ccoordinates&exintro=1&explaintext=1&exlimit=20&exchars=400&colimit=20', { headers }, 'Wikipedia');
  if (r?.error) throw new Error(`Wikipedia said: ${String(r.error.info ?? r.error.code ?? 'no').replace(/\.$/, '')}.`);
  /** @type {[string, number, number, string][]} */
  const pages = [];
  for (const g of Array.isArray(r?.query?.pages) ? r.query.pages : []) {
    const c = Array.isArray(g?.coordinates) ? g.coordinates[0] : null;
    if (typeof g?.title !== 'string' || !isNum(c?.lat) || !isNum(c?.lon)) continue;
    pages.push([g.title, r4(c.lat), r4(c.lon), typeof g.extract === 'string' ? g.extract.trim() : '']);
  }
  return { count: pages.length, content: { at: p.at, radius: WIKI_RADIUS_M, pages } };
}

/**
 * The names to look for in Wikivoyage: the plan's (the trip's places, then the stops), then the
 * titles of the Wikipedia articles in the pack, nearest to their point first.
 * @param {Workspace} ws @param {string} scope @param {PackPlan} plan @param {Map<string, PackFile>} files
 */
async function namesFor(ws, scope, plan, files) {
  /** @type {[string, number][]} */
  const titles = [];
  for (const f of files.values()) {
    if (f.kind !== 'wikipedia') continue;
    const v = await ws.readJSON(scope, f.path).catch(() => null);
    const at = Array.isArray(v?.at) && isNum(v.at[0]) && isNum(v.at[1]) ? { lat: v.at[0], lng: v.at[1] } : null;
    for (const g of Array.isArray(v?.pages) ? v.pages : []) {
      if (at && Array.isArray(g) && typeof g[0] === 'string' && isNum(g[1]) && isNum(g[2])) titles.push([g[0], meters(at, { lat: g[1], lng: g[2] })]);
    }
  }
  titles.sort((a, b) => a[1] - b[1]);
  return [...new Set([...plan.names, ...titles.map((t) => t[0])])].slice(0, MAX_NAMES);
}

/**
 * Which names have a Wikivoyage guide, in their order, at most 12, following its redirects and
 * leaving out its disambiguation pages. Only names are sent (choice 3).
 * @param {string[]} names @param {Ask} ask @param {Record<string, string>} headers
 * @returns {Promise<{ title: string, asked: string[] }[]>}
 */
async function findGuides(names, ask, headers) {
  const candidates = [...new Set(names.flatMap(guideTitles))];
  /** @type {Map<string, string | null>} what each candidate leads to */
  const resolved = new Map();
  for (let i = 0; i < candidates.length; i += TITLES_PER_ASK) {
    const batch = candidates.slice(i, i + TITLES_PER_ASK);
    const r = await ask(`${WIKIVOYAGE}?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=pageprops&ppprop=disambiguation&titles=${encodeURIComponent(batch.join('|'))}`, { headers }, 'Wikivoyage');
    if (r?.error) throw new Error(`Wikivoyage said: ${String(r.error.info ?? r.error.code ?? 'no').replace(/\.$/, '')}.`);
    const q = r?.query ?? {};
    const steps = new Map([...(Array.isArray(q.normalized) ? q.normalized : []), ...(Array.isArray(q.redirects) ? q.redirects : [])]
      .filter((x) => typeof x?.from === 'string' && typeof x?.to === 'string').map((x) => [x.from, x.to]));
    const ok = new Set((Array.isArray(q.pages) ? q.pages : [])
      .filter((p) => typeof p?.title === 'string' && !p.missing && !p.invalid && !(p.pageprops && typeof p.pageprops === 'object' && 'disambiguation' in p.pageprops))
      .map((p) => p.title));
    for (const c of batch) {
      let t = c;
      for (let k = 0; k < 3 && steps.has(t); k++) t = /** @type {string} */ (steps.get(t));
      resolved.set(c, ok.has(t) ? t : null);
    }
  }
  /** @type {Map<string, Set<string>>} */
  const guides = new Map();
  for (const n of names) {
    const t = guideTitles(n).map((c) => resolved.get(c)).find((x) => typeof x === 'string');
    if (!t || (!guides.has(t) && guides.size >= MAX_GUIDES)) continue;
    if (!guides.has(t)) guides.set(t, new Set());
    guides.get(t)?.add(n);
  }
  return [...guides].map(([title, asked]) => ({ title, asked: [...asked] }));
}

/** A Wikivoyage guide's text, with its sections marked "== See ==". @param {string} title @param {Ask} ask @param {Record<string, string>} headers */
async function article(title, ask, headers) {
  const r = await ask(`${WIKIVOYAGE}?action=query&format=json&formatversion=2&origin=*&prop=extracts&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(title)}`, { headers }, 'Wikivoyage');
  const text = Array.isArray(r?.query?.pages) ? r.query.pages[0]?.extract : undefined;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`Wikivoyage sent no text for ${title}.`);
  return text;
}
```

`sw.js` SHELL: add `'/src/core/pack/download.js',` in path order.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/pack-download.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A src/core/pack/download.js sw.js test/unit/pack-kit.js test/unit/pack-download.test.js && git commit -m "Downloading the offline pack into the trip: one request at a time, identified, each part a file; failures noted, three in a row stop it, and the next download goes on from there (spec §11.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 4: The tools read the pack first

**Files:**
- Create: `src/core/pack/read.js`
- Modify: `src/plugins/places/index.js`, `sw.js` (SHELL)
- Test: `test/unit/pack-read.test.js`, `test/unit/plugin-places.test.js`

**Interfaces:**
- Consumes: Task 3's `MANIFEST`, `readManifest`, `Manifest`, files' shapes; Task 1's `OsmRow`.
- Produces: `loadPack(ws, scope): Promise<Pack | null>`; `class Pack { manifest; day; covers(p, radius); touches(p); places(p, radius, kinds): any[][]; pages(p, radius): any[][]; guide(name): Promise<{ title, text } | null>; name(p): { name, m } | null }`; `toLine(p, points): number`; `NAME_M` 500.

- [ ] **Step 1: Write the failing tests**

`test/unit/pack-read.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, toLine } from '../../src/core/pack/read.js';
import { downloadPack, MANIFEST } from '../../src/core/pack/download.js';
import { packTrip, services } from './pack-kit.js';

test('meters from a point to a line, or to a point', () => {
  const east = /** @type {[number, number][]} */ ([[36, -121], [36, -120]]);
  assert.ok(Math.abs(toLine({ lat: 36.09, lng: -120.5 }, east) - 10_000) < 100, 'beside the middle');
  assert.ok(Math.abs(toLine({ lat: 36, lng: -119.9 }, east) - 9_000) < 100, 'past the end');
  assert.ok(toLine({ lat: 36, lng: -120.7 }, east) < 1, 'on it');
  assert.ok(Math.abs(toLine({ lat: 36.09, lng: -121 }, [[36, -121]]) - 10_000) < 100, 'a point');
});

test("a downloaded pack: what it covers, its places and pages, its guides by name, and live mode's names", async () => {
  const { ws, trip } = await packTrip();
  await downloadPack({ ws, scope: trip, ...services(), version: '1.0.0', gapMs: 0 });
  const pack = await loadPack(ws, trip);
  assert.ok(pack);
  assert.equal(pack.day, new Date().toISOString().slice(0, 10));
  const bixby = { lat: 36.3715, lng: -121.9017 };
  assert.equal(pack.covers(bixby, 1000), true);
  assert.equal(pack.covers(bixby, 6000), false);
  assert.equal(pack.touches({ lat: 36.30, lng: -121.83 }), true); // on the way
  assert.equal(pack.touches({ lat: 36.60, lng: -121.89 }), false); // Monterey
  assert.deepEqual(pack.places(bixby, 1000, ['sights']).map((r) => r[0]), ['Bixby Bridge Vista Point']);
  assert.deepEqual(pack.places(bixby, 1000, ['toilets']).map((r) => [r[0], r[1], r[5]]), [['', 'toilets', 'osm']]);
  const pages = pack.pages(bixby, 2000);
  assert.deepEqual(pages.map((r) => r.slice(0, 2)), [['Bixby Creek Bridge', 'wikipedia article']]);
  assert.match(pages[0][6], /^Bixby Creek Bridge is a reinforced concrete .* https:\/\/en\.wikipedia\.org\/wiki\/Bixby_Creek_Bridge$/);
  assert.equal((await pack.guide('big sur'))?.title, 'Big Sur');
  assert.equal((await pack.guide('Cambria'))?.title, 'Cambria (California)');
  assert.equal((await pack.guide('Cambria, California'))?.title, 'Cambria (California)');
  assert.equal(await pack.guide('Monterey'), null);
  assert.deepEqual(pack.name({ lat: 36.3715, lng: -121.9017 }), { name: 'Bixby Creek Bridge', m: 0 });
  assert.equal(pack.name({ lat: 36.2203, lng: -121.7612 })?.name, 'Nepenthe (restaurant)'); // a restaurant is no place name; its article is
  assert.equal(pack.name({ lat: 36.5, lng: -121.95 }), null);
  assert.equal(await loadPack(ws, trip), pack); // read once for each version of the manifest
});

test('a broken pack is no pack, and a broken part is left out: never an error', async () => {
  const { ws, trip } = await packTrip();
  assert.equal(await loadPack(ws, trip), null);
  assert.equal(await loadPack(ws, null), null);
  await ws.write(trip, MANIFEST, '{"format":', { author: 'system', type: 'text/plain' });
  assert.equal(await loadPack(ws, trip), null);
  await downloadPack({ ws, scope: trip, ...services(), version: '1.0.0', gapMs: 0 });
  const m = /** @type {any} */ (await ws.readJSON(trip, MANIFEST));
  const osm = m.files.filter((/** @type {any} */ f) => f.kind === 'osm');
  await ws.write(trip, osm[0].path, '{"area":', { author: 'user', type: 'text/plain' });
  await ws.write(trip, osm[1].path, { area: { points: 'x', radius: 5000 }, rows: [] }, { author: 'user' });
  await ws.write(trip, osm[2].path, { area: { points: [[36.3, -121.85]], radius: 3000 }, rows: [['n9', 'Odd', 'viewpoint', 'x', 1, '', 'sights'], ['n10', 'Fine', 'viewpoint', 36.3, -121.85, '', 'sights']] }, { author: 'user' });
  await ws.patch(trip, MANIFEST, { at: '2026-10-17T00:00:00.000Z' }, { author: 'system' });
  const pack = await loadPack(ws, trip);
  assert.ok(pack);
  assert.deepEqual(pack.places({ lat: 36.3, lng: -121.85 }, 1000, ['sights']).map((r) => r[0]), ['Fine']);
  await ws.write(trip, m.guides.find((/** @type {any} */ g) => g.title === 'Big Sur').path, 'not json', { author: 'user', type: 'text/plain' });
  assert.equal(await pack.guide('Big Sur'), null);
});
```

Add to `test/unit/plugin-places.test.js`: `setup` takes an optional trip, so the tools run with it open:
```js
async function setup({ trip = false } = {}) {
  const registry = new Registry();
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const tripId = trip ? await createTrip(ws, { title: 'Big Sur' }) : null;
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** @type {{ url: string, init: any, at: number }[]} */
  const asked = [];
  /** @param {string} name @param {any} input @param {(url: string, init: any) => any} answer */
  const run = (name, input, answer) => tools[name].run(input, {
    scope: tripId ?? 'me', trip: tripId, signal: new AbortController().signal, model: null, wake: 'w', author: 'shiori',
    fetch: async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
      asked.push({ url, init, at: Date.now() });
      const a = await answer(url, init);
      return a instanceof Response ? a : new Response(JSON.stringify(a));
    },
  });
  return { run, asked, ws, trip: tripId };
}
```
(`createTrip` joins the `scopes.js` import.) A helper and the new tests:
```js
/** Writes a small pack by McWay Falls into the trip, as a download would leave it. @param {any} ws @param {string} trip */
async function mcwayPack(ws, trip) {
  const at = '2026-10-16T09:00:00.000Z';
  await ws.write(trip, '/offline/osm/o1.json', JSON.stringify({ area: { points: [[36.158, -121.672]], radius: 5000 }, rows: [
    ['n1', 'McWay Falls Overlook', 'viewpoint', 36.1585, -121.6722, '', 'sights'],
    ['n2', 'Big Sur Bakery', 'cafe', 36.2700, -121.8080, '', 'food'],
    ['n3', 'Julia Pfeiffer Burns cafe', 'cafe', 36.1600, -121.6700, '', 'food'],
  ] }), { author: 'system' });
  await ws.write(trip, '/offline/wikipedia/w1.json', JSON.stringify({ at: [36.158, -121.672], radius: 10000, pages: [['McWay Falls', 36.1577, -121.6716, 'McWay Falls is an 80-foot waterfall that flows year-round from McWay Creek in Julia Pfeiffer Burns State Park.']] }), { author: 'system' });
  await ws.write(trip, '/offline/wikivoyage/g1.json', JSON.stringify({ title: 'Cambria (California)', text: 'Cambria is a town.\n\n== See ==\nMoonstone Beach.' }), { author: 'system' });
  await ws.write(trip, '/offline/wikivoyage/g2.json', JSON.stringify({ title: 'San Simeon', text: 'San Simeon is home to Hearst Castle.' }), { author: 'system' });
  await ws.write(trip, '/offline/pack.json', JSON.stringify({ format: 1, key: 'k', at, failed: [], full: false, stopped: false, bytes: 1000,
    files: [{ id: 'o1', kind: 'osm', path: '/offline/osm/o1.json', bytes: 400, items: 3 }, { id: 'w1', kind: 'wikipedia', path: '/offline/wikipedia/w1.json', bytes: 300, items: 1 },
      { id: 'g1', kind: 'wikivoyage', path: '/offline/wikivoyage/g1.json', bytes: 100, items: 1 }, { id: 'g2', kind: 'wikivoyage', path: '/offline/wikivoyage/g2.json', bytes: 100, items: 1 }],
    guides: [{ title: 'Cambria (California)', asked: ['Cambria, California'], path: '/offline/wikivoyage/g1.json' }, { title: 'San Simeon', asked: ['Hearst Castle'], path: '/offline/wikivoyage/g2.json' }] }), { author: 'system' });
}
const nothing = () => { throw new Error('no request should be made'); };

test('nearby reads the offline pack first: no request where it covers the whole circle (spec §8)', async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  const out = await run('nearby', { ...McWay, radius: 1000, kinds: ['sights'] }, nothing);
  const rows = out.split('\n');
  assert.equal(rows[0], 'name\tkind\tdistance_m\tlat\tlng\tsource\tnote');
  assert.deepEqual(rows.slice(1, -1).map((r) => r.split('\t')[0]), ['McWay Falls', 'McWay Falls Overlook']);
  assert.match(rows[1], /\twikipedia\tMcWay Falls is an 80-foot waterfall .*State Park\. https:\/\/en\.wikipedia\.org\/wiki\/McWay_Falls$/);
  assert.equal(rows.at(-1), 'From the offline pack (downloaded 2026-10-16).');
  const food = await run('nearby', { ...McWay, radius: 1000, kinds: ['food'] }, nothing);
  assert.deepEqual(food.split('\n').slice(1, -1).map((r) => r.split('\t')[0]), ['McWay Falls', 'Julia Pfeiffer Burns cafe']);
});

test("past the pack's edge nearby asks the services, and the pack fills in for any that don't answer, saying so", async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  const wiki = { query: { geosearch: [{ title: 'Partington Cove', lat: 36.175, lon: -121.69, dist: 2400 }] } };
  const online = await run('nearby', { ...McWay, radius: 8000 }, (url) => (url.includes('overpass') ? { elements: [] } : wiki));
  assert.ok(asked.some((a) => a.url.includes('overpass')));
  assert.doesNotMatch(online, /offline pack/);
  const down = await run('nearby', { ...McWay, radius: 8000 }, () => { throw new Error("annai couldn't reach overpass-api.de. Is the device offline?"); });
  assert.match(down, /\nOpenStreetMap and Wikipedia didn't answer, so these come from the offline pack \(downloaded 2026-10-16\)\.$/);
  assert.match(down, /McWay Falls Overlook/);
  const half = await run('nearby', { ...McWay, radius: 8000 }, (url) => (url.includes('overpass') ? new Response('', { status: 504 }) : wiki));
  assert.match(half, /Partington Cove/);
  assert.match(half, /\nOpenStreetMap didn't answer, so its places come from the offline pack \(downloaded 2026-10-16\)\.$/);
  // Outside the pack, with both services down, it says so as before.
  await assert.rejects(run('nearby', { lat: 36.6, lng: -121.9 }, () => { throw new Error('offline'); }), /Neither OpenStreetMap nor Wikipedia answered/);
});

test('guide reads the pack first: by its title, without "(California)", or by a name that led to it; a section too', async () => {
  const { run, ws, trip } = await setup({ trip: true });
  await mcwayPack(ws, /** @type {string} */ (trip));
  assert.equal(await run('guide', { place: 'Cambria' }, nothing), 'Cambria (California) (Wikivoyage, offline pack of 2026-10-16)\n\nCambria is a town.\n\nSections: See. Ask for one with section.');
  assert.equal(await run('guide', { place: 'cambria, california', section: 'see' }, nothing), 'Cambria (California): See (Wikivoyage, offline pack of 2026-10-16)\n\nMoonstone Beach.');
  assert.match(await run('guide', { place: 'Hearst Castle' }, nothing), /^San Simeon \(Wikivoyage, offline pack of 2026-10-16\)/);
  const page = { query: { pages: { 1: { title: 'Big Sur', extract: 'Big Sur is a region.' } } } };
  assert.equal(await run('guide', { place: 'Big Sur' }, () => page), 'Big Sur (Wikivoyage)\n\nBig Sur is a region.');
});

test('a broken pack is no pack: the tools go online', async () => {
  const { run, ws, trip, asked } = await setup({ trip: true });
  await ws.write(/** @type {string} */ (trip), '/offline/pack.json', '{"format":1,', { author: 'system', type: 'text/plain' });
  const page = { query: { pages: { 1: { title: 'Big Sur', extract: 'Big Sur is a region.' } } } };
  assert.equal(await run('guide', { place: 'Big Sur' }, () => page), 'Big Sur (Wikivoyage)\n\nBig Sur is a region.');
  await run('nearby', McWay, (url) => (url.includes('overpass') ? { elements: [] } : { query: { geosearch: [] } }));
  assert.ok(asked.some((a) => a.url.includes('overpass')));
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/pack-read.test.js test/unit/plugin-places.test.js`
Expected: FAIL: `src/core/pack/read.js` can't be found; the places tests fail (no pack is read).

- [ ] **Step 3: Write the code**

`src/core/pack/read.js`:
```js
import { meters } from '../live/geo.js';
import { MANIFEST, readManifest } from './download.js';

/**
 * The offline pack as the places tools and live mode read it (spec §8: "the tools read the offline
 * pack first"). A part that is missing or broken is left out, never an error: the pack helps; it is
 * never a must.
 * @typedef {import('./osm.js').OsmRow} OsmRow
 * @typedef {import('./download.js').Manifest} Manifest
 * @typedef {{ points: [number, number][], radius: number }} Area
 * @typedef {[title: string, lat: number, lng: number, summary: string]} WikiPage
 * @typedef {{ lat: number, lng: number }} Point
 */

/** Live mode is told it is near a place the pack names this close (choice 7). */
export const NAME_M = 500;
/** The kinds whose places name where the user is. */
const NAMED = new Set(['sights', 'parks', 'lodging']);
const isNum = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x);
const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/** Meters from a point to an area's line, or to its one point (flat near the point, which is plenty for 40 km). @param {Point} p @param {[number, number][]} pts */
export function toLine(p, pts) {
  if (pts.length === 1) return meters(p, { lat: pts[0][0], lng: pts[0][1] });
  const k = Math.cos((p.lat * Math.PI) / 180);
  const xy = (/** @type {[number, number]} */ q) => [(q[1] - p.lng) * 111_320 * k, (q[0] - p.lat) * 110_574];
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = xy(pts[i - 1]);
    const [bx, by] = xy(pts[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** A summary cut to about 200 characters, at a word. @param {string} s */
function short(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= 200 ? t : `${t.slice(0, 200).replace(/\s+\S*$/, '')}…`;
}

export class Pack {
  /** @type {{ area: Area, rows: OsmRow[] }[]} */
  #osm;
  /** @type {WikiPage[]} */
  #wiki;
  /** @type {[string, number, number][]} */
  #names = [];
  /** @type {(path: string) => Promise<any>} */
  #read;

  /** @param {Manifest} manifest @param {{ area: Area, rows: OsmRow[] }[]} osm @param {WikiPage[]} wiki @param {(path: string) => Promise<any>} read */
  constructor(manifest, osm, wiki, read) {
    this.manifest = manifest;
    this.#osm = osm;
    this.#wiki = wiki;
    this.#read = read;
    for (const { rows } of osm) for (const r of rows) if (r[1] && r[6].split(',').some((k) => NAMED.has(k))) this.#names.push([r[1], r[3], r[4]]);
    for (const w of wiki) this.#names.push([w[0], w[1], w[2]]);
  }

  /** The day it was downloaded: "2026-10-16". */
  get day() {
    return this.manifest.at.slice(0, 10);
  }

  /** Whether one of its OpenStreetMap areas holds the whole circle. @param {Point} p @param {number} radius */
  covers(p, radius) {
    return this.#osm.some((o) => toLine(p, o.area.points) + radius <= o.area.radius);
  }

  /** Whether the point is inside one of its areas. @param {Point} p */
  touches(p) {
    return this.#osm.some((o) => toLine(p, o.area.points) <= o.area.radius);
  }

  /** nearby's rows for its OpenStreetMap places of these kinds within radius. @param {Point} p @param {number} radius @param {string[]} kinds @returns {any[][]} */
  places(p, radius, kinds) {
    const want = new Set(kinds);
    const seen = new Set();
    /** @type {any[][]} */
    const out = [];
    for (const { rows } of this.#osm) {
      for (const r of rows) {
        if (seen.has(r[0]) || !r[6].split(',').some((k) => want.has(k))) continue;
        const d = meters(p, { lat: r[3], lng: r[4] });
        if (d > radius) continue;
        seen.add(r[0]);
        out.push([r[1], r[2], Math.round(d), r[3], r[4], 'osm', r[5]]);
      }
    }
    return out;
  }

  /** nearby's rows for its Wikipedia articles within radius, each with its summary (choice 6). @param {Point} p @param {number} radius @returns {any[][]} */
  pages(p, radius) {
    const seen = new Set();
    /** @type {any[][]} */
    const out = [];
    for (const [title, lat, lng, summary] of this.#wiki) {
      const d = meters(p, { lat, lng });
      if (d > radius || seen.has(title)) continue;
      seen.add(title);
      out.push([title, 'wikipedia article', Math.round(d), lat, lng, 'wikipedia', `${short(summary)} https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`.trim()]);
    }
    return out;
  }

  /** Its guide for a name: by title, by title without "(California)", or by a name that led to it. @param {string} name @returns {Promise<{ title: string, text: string } | null>} */
  async guide(name) {
    const n = norm(String(name));
    const g = this.manifest.guides.find((x) => [x.title, x.title.replace(/\s*\([^)]*\)$/, ''), ...x.asked].some((t) => norm(t) === n));
    if (!g) return null;
    const v = await this.#read(g.path).catch(() => null);
    return typeof v?.text === 'string' && v.text.trim() ? { title: g.title, text: v.text } : null;
  }

  /** The nearest sight, park, place to stay or Wikipedia article within 500 m, for live mode. @param {Point} p @returns {{ name: string, m: number } | null} */
  name(p) {
    /** @type {{ name: string, m: number } | null} */
    let best = null;
    for (const [name, lat, lng] of this.#names) {
      const m = meters(p, { lat, lng });
      if (m <= NAME_M && (!best || m < best.m)) best = { name, m };
    }
    return best;
  }
}

/** @param {any} a @returns {a is Area} */
const goodArea = (a) => Boolean(a) && isNum(a.radius) && Array.isArray(a.points) && a.points.length > 0 && a.points.every((/** @type {any} */ q) => Array.isArray(q) && isNum(q[0]) && isNum(q[1]));
/** @param {any} r @returns {r is OsmRow} */
const goodRow = (r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string' && typeof r[2] === 'string' && isNum(r[3]) && isNum(r[4]) && typeof r[5] === 'string' && typeof r[6] === 'string';
/** @param {any} w @returns {w is WikiPage} */
const goodPage = (w) => Array.isArray(w) && typeof w[0] === 'string' && isNum(w[1]) && isNum(w[2]) && typeof w[3] === 'string';

/** @type {Map<string, { hash: string, pack: Pack }>} */
const loaded = new Map();

/**
 * A trip's offline pack, read once for each version of its manifest; null when it has none.
 * @param {import('../workspace.js').Workspace} ws @param {string | null | undefined} scope @returns {Promise<Pack | null>}
 */
export async function loadPack(ws, scope) {
  if (!scope) return null;
  const got = await ws.read(scope, MANIFEST).catch(() => undefined);
  if (!got) {
    loaded.delete(scope);
    return null;
  }
  const hit = loaded.get(scope);
  if (hit && hit.hash === got.entry.hash) return hit.pack;
  const manifest = await readManifest(ws, scope);
  if (!manifest) return null;
  /** @type {{ area: Area, rows: OsmRow[] }[]} */
  const osm = [];
  /** @type {WikiPage[]} */
  const wiki = [];
  for (const f of manifest.files) {
    if (f.kind === 'wikivoyage') continue;
    const v = await ws.readJSON(scope, f.path).catch(() => null);
    if (f.kind === 'osm' && goodArea(v?.area) && Array.isArray(v.rows)) osm.push({ area: v.area, rows: v.rows.filter(goodRow) });
    else if (f.kind === 'wikipedia' && Array.isArray(v?.pages)) wiki.push(...v.pages.filter(goodPage));
  }
  const pack = new Pack(manifest, osm, wiki, (path) => ws.readJSON(scope, path));
  loaded.set(scope, { hash: got.entry.hash, pack });
  if (loaded.size > 3) loaded.delete(/** @type {string} */ (loaded.keys().next().value));
  return pack;
}
```

In `src/plugins/places/index.js`:
- Import `loadPack` from `'../../core/pack/read.js'`.
- Add, after `sunOnly`:
```js
/** A guide's introduction and the names of its sections; or one section. @param {string} title @param {string} text @param {string | undefined} section @param {string} source */
function guideText(title, text, section, source) {
  const heads = [...text.matchAll(/^(={2,4}) (.+?) \1$/gm)];
  if (!section) {
    const intro = (heads.length ? text.slice(0, heads[0].index) : text).trim();
    return `${title} (${source})\n\n${intro}${heads.length ? `\n\nSections: ${heads.map((m) => m[2]).join(', ')}. Ask for one with section.` : ''}`;
  }
  const k = heads.findIndex((m) => m[2].toLowerCase() === String(section).toLowerCase());
  if (k < 0) return `${title} has no section "${section}". Its sections: ${heads.map((m) => m[2]).join(', ')}.`;
  const level = heads[k][1].length;
  const end = heads.slice(k + 1).find((m) => m[1].length <= level);
  const body = text.slice(/** @type {number} */ (heads[k].index) + heads[k][0].length, end?.index ?? text.length).trim();
  return `${title}: ${heads[k][2]} (${source})\n\n${body}`;
}
```
- `nearby`'s description gains ` Reads the trip's offline pack first, so it works without a connection along the planned route.`; its `run` becomes:
```js
      async run(i, call) {
        const radius = Math.round(Math.min(20000, Math.max(50, i.radius ?? 1000)));
        const kinds = i.kinds?.length ? i.kinds : ['sights', 'food'];
        const answer = (/** @type {any[][]} */ rows) => tsv(['name', 'kind', 'distance_m', 'lat', 'lng', 'source', 'note'], rows.sort((a, b) => a[2] - b[2]).slice(0, 40));
        // The offline pack first (spec §8): where it holds the whole circle, nothing is asked.
        const pack = await loadPack(annai.files, call.trip).catch(() => null);
        if (pack?.covers(i, radius)) return `${answer([...pack.places(i, radius, kinds), ...pack.pages(i, radius)])}\nFrom the offline pack (downloaded ${pack.day}).`;
        const at = `around:${radius},${round(i.lat)},${round(i.lng)}`;
        // Overpass cuts its output in id order, not by distance, so ask for plenty and keep the nearest 40.
        const query = `[out:json][timeout:20];(${overpassFilters(kinds).map((f) => `nwr(${at})${f};`).join('')});out center tags 400;`;
        /** @type {any[][] | null} */
        let osm = null;
        for (const server of OVERPASS) {
          try {
            const data = await json(server, call, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
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
          return `${answer([...(osm ?? pack.places(i, radius, kinds)), ...(wiki ?? pack.pages(i, radius))])}\n${missing.join(' and ')} didn't answer, so ${what} from the offline pack (downloaded ${pack.day}).`;
        }
        if (osm === null && wiki === null) throw new Error('Neither OpenStreetMap nor Wikipedia answered. Try again in a moment.');
        const out = answer([...(osm ?? []), ...(wiki ?? [])]);
        return osm ? out : `${out}\nOpenStreetMap didn't answer; these are Wikipedia articles only.`;
      },
```
- `guide`'s description gains ` Reads the trip's offline pack first.`; its `run` becomes:
```js
      async run(i, call) {
        const pack = await loadPack(annai.files, call.trip).catch(() => null);
        const saved = pack ? await pack.guide(i.place).catch(() => null) : null;
        if (pack && saved) return guideText(saved.title, saved.text, i.section, `Wikivoyage, offline pack of ${pack.day}`);
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
```

`sw.js` SHELL: add `'/src/core/pack/read.js',` in path order.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/pack-read.test.js test/unit/plugin-places.test.js`
Expected: PASS, the earlier places tests too.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A src/core/pack/read.js src/plugins/places/index.js sw.js test/unit/pack-read.test.js test/unit/plugin-places.test.js && git commit -m "nearby and guide read the offline pack first: no request where it covers what is asked, and it fills in for services that don't answer, saying so; a broken pack is no pack (spec §8, §11.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 5: Keeping the pack: status, one download at a time, Wi-Fi updates, names for live mode

**Files:**
- Create: `src/core/pack/keeper.js`
- Modify: `src/plugins/files/index.js`, `sw.js` (SHELL)
- Test: `test/unit/pack-keeper.test.js`, `test/unit/plugin-files.test.js`

**Interfaces:**
- Consumes: Tasks 2 to 4: `planFor`, `estimate`, `likelyGuides`, `downloadPack`, `readManifest`, `pathOf`, `DIR`, `MANIFEST`, `STALE_MS`, `loadPack`; `tracedFetch` (`src/core/agent/net.js`); `logEvent` (`src/core/events.js`); `PLAN_FILE`.
- Produces: `class PackKeeper` with `constructor({ store, ws, agent, version, connection, visible?, fetch?, quietMs?, pokeMs?, gapMs?, now? })`, `running`, `onChange(fn) → off`, `status(scope): Promise<PackStatus>`, `download(scope, { auto? }): Promise<Manifest>`, `stop()`, `poke()`, `name(p)`, `dispose()`; `PackStatus = { stops, cut, manifest, why: 'plan' | 'missing' | 'old' | null, estimate, running }`; `QUIET_MS` 60 s. The trip log gains `pack.download { files, bytes, guides, failed, stopped, full, auto }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/pack-keeper.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackKeeper } from '../../src/core/pack/keeper.js';
import { STALE_MS } from '../../src/core/pack/download.js';
import { packTrip, services, fakeAgent, STOPS } from './pack-kit.js';

/** @param {() => boolean | Promise<boolean>} ok */
async function until(ok, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** @param {{ connection?: string, visible?: boolean, now?: () => number }} [o] */
async function kit(o = {}) {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  const net = services();
  let connection = o.connection ?? 'unknown';
  let visible = o.visible ?? true;
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, version: '1.2.3', connection: () => connection, visible: () => visible, fetch: net.fetch, quietMs: 20, pokeMs: 10, gapMs: 0, now: o.now });
  return { ...t, agent, net, keeper, set: (/** @type {{ connection?: string, visible?: boolean }} */ s) => { connection = s.connection ?? connection; visible = s.visible ?? visible; } };
}

test('status before any download: the stops, about how much it takes, nothing outdated', async () => {
  const { keeper, trip } = await kit();
  const s = await keeper.status(trip);
  assert.equal(s.stops, 2);
  assert.equal(s.manifest, null);
  assert.equal(s.why, null);
  assert.ok(s.estimate > 50 * 1024 && s.estimate < 200 * 1024, String(s.estimate));
  assert.equal(s.running, null);
  keeper.dispose();
});

test("one download at a time, with progress; then the pack is up to date, and the trip's log says so", async () => {
  const { keeper, trip, store } = await kit();
  /** @type {any[]} */
  const seen = [];
  keeper.onChange(() => seen.push(keeper.running && { ...keeper.running }));
  const a = keeper.download(trip);
  assert.equal(keeper.download(trip), a);
  const m = await a;
  assert.equal(m.files.length, 7);
  assert.ok(seen.some((r) => r?.total > 0 && r.label));
  assert.equal(seen.at(-1), null);
  const s = await keeper.status(trip);
  assert.equal(s.why, null);
  assert.ok(s.manifest);
  const log = await store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['pack.download'] }));
  assert.deepEqual(log.map((e) => e.data), [{ files: 7, bytes: m.bytes, guides: 2, failed: 0, stopped: false, full: false, auto: false }]);
  keeper.dispose();
});

test('why an update: the plan changed, parts are missing, or it is a month old', async () => {
  let now = Date.now();
  const { keeper, trip, ws } = await kit({ now: () => now });
  await keeper.download(trip);
  await ws.write(trip, '/plan/mcway.json', { id: 'mcway', title: 'McWay Falls', fixed: false, start: { at: '2026-11-27T21:45:00Z' }, place: { name: 'McWay Falls', lat: 36.158, lng: -121.672 } }, { author: 'user' });
  const changed = await keeper.status(trip);
  assert.equal(changed.why, 'plan');
  assert.ok(changed.estimate > 0);
  await ws.delete(trip, '/plan/mcway.json', { author: 'user' });
  const m = /** @type {any} */ (await ws.readJSON(trip, '/offline/pack.json'));
  await ws.delete(trip, m.files[0].path, { author: 'user' });
  assert.equal((await keeper.status(trip)).why, 'missing');
  await keeper.download(trip);
  assert.equal((await keeper.status(trip)).why, null);
  now += STALE_MS + 1;
  assert.equal((await keeper.status(trip)).why, 'old');
  keeper.dispose();
});

test('stop() stops the download; what came stays', async () => {
  const { keeper, trip } = await kit();
  const off = keeper.onChange(() => { if ((keeper.running?.done ?? 0) >= 2) keeper.stop(); });
  const m = await keeper.download(trip);
  off();
  assert.equal(m.stopped, true);
  assert.equal((await keeper.status(trip)).why, 'missing');
  keeper.dispose();
});

test('opening another trip stops a running download (choice 10)', async () => {
  const { keeper, trip, agent } = await kit();
  const off = keeper.onChange(() => { if (keeper.running?.done === 1) agent.open(null); });
  const m = await keeper.download(trip);
  off();
  assert.equal(m.stopped, true);
  keeper.dispose();
});

test('on Wi-Fi an outdated pack is brought up to date by itself once the plan is quiet; not on mobile data, not before a first download, not hidden', async () => {
  const { keeper, trip, ws, net, set } = await kit({ connection: 'cellular' });
  const plan = (/** @type {number} */ lat) => ws.write(trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat } }, { author: 'user' });
  await plan(36.2);
  set({ connection: 'wifi' });
  keeper.poke();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(net.asked.length, 0, 'no first download by itself');
  await keeper.download(trip);
  const asked = net.asked.length;
  set({ connection: 'cellular' });
  await plan(36.19);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(net.asked.length, asked, 'not on mobile data');
  set({ connection: 'wifi', visible: false });
  keeper.poke();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(net.asked.length, asked, 'not while annai is hidden');
  set({ visible: true });
  keeper.poke();
  await until(async () => (await keeper.status(trip)).why === null && net.asked.length > asked);
  const log = await keeper.o.store.tx(['events'], 'readonly', (t) => t.listEvents(trip, { types: ['pack.download'] }));
  assert.equal(log.at(-1)?.data.auto, true);
  keeper.dispose();
});

test('by itself at most once an hour, even when parts keep failing', async () => {
  const t = await packTrip();
  const agent = fakeAgent(t.trip);
  let fail = false;
  const net = services({ overpass: (url, init) => (fail ? new Response('', { status: 503 }) : { elements: [] }) });
  const keeper = new PackKeeper({ store: t.store, ws: t.ws, agent, version: '1', connection: () => 'wifi', fetch: net.fetch, quietMs: 10, pokeMs: 5, gapMs: 0 });
  await keeper.download(t.trip);
  fail = true;
  await t.ws.write(t.trip, '/plan/nepenthe.json', { ...STOPS.nepenthe, place: { ...STOPS.nepenthe.place, lat: 36.2 } }, { author: 'user' });
  await until(async () => ((await keeper.status(t.trip)).manifest?.failed.length ?? 0) > 0); // the update by itself ran, and failed in part
  const asked = net.asked.length;
  keeper.poke();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(net.asked.length, asked);
  keeper.dispose();
});

test("live mode's names come from the open trip's pack", async () => {
  const { keeper, trip, agent } = await kit();
  const here = { lat: 36.3715, lng: -121.9017 };
  assert.equal(keeper.name(here), null);
  await keeper.download(trip);
  await until(() => keeper.name(here) !== null);
  assert.equal(keeper.name(here)?.name, 'Bixby Creek Bridge');
  agent.open(null);
  await until(() => keeper.name(here) === null);
  keeper.dispose();
});
```

Add to `test/unit/plugin-files.test.js`:
```js
test('list and search leave the offline pack out unless asked for it (choice 8)', async () => {
  const { ws, trip, run } = await setup();
  await ws.write(trip, '/notes/lunch.md', 'Nepenthe at noon\n', { author: 'user' });
  await ws.write(trip, '/offline/pack.json', '{"format":1}', { author: 'system' });
  await ws.write(trip, '/offline/osm/o1.json', '{"rows":[["n1","Nepenthe","restaurant"]]}', { author: 'system' });
  const all = await run('list', { path: '/' });
  assert.doesNotMatch(all, /\/trip\/offline\//);
  assert.match(all, /\/trip\/notes\/lunch\.md/);
  assert.doesNotMatch(await run('list', { path: '/trip' }), /offline/);
  assert.deepEqual((await run('search', { query: 'nepenthe' })).split('\n').slice(1).map((r) => r.split('\t')[0]), ['/trip/notes/lunch.md']);
  assert.match(await run('list', { path: '/trip/offline/' }), /\/trip\/offline\/osm\/o1\.json/);
  assert.match(await run('search', { query: 'nepenthe', path: '/trip/offline' }), /\/trip\/offline\/osm\/o1\.json/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/pack-keeper.test.js test/unit/plugin-files.test.js`
Expected: FAIL: `src/core/pack/keeper.js` can't be found; the files test lists `/trip/offline/`.

- [ ] **Step 3: Write the code**

`src/core/pack/keeper.js`:
```js
import { planFor, estimate, likelyGuides } from './plan.js';
import { downloadPack, readManifest, pathOf, DIR, MANIFEST, STALE_MS } from './download.js';
import { loadPack } from './read.js';
import { tracedFetch } from '../agent/net.js';
import { logEvent } from '../events.js';
import { PLAN_FILE } from '../plan.js';

/**
 * Keeps each trip's offline pack (spec §11.5): what it holds and would take, downloading it when
 * asked, and, once a trip has one, bringing it up to date by itself on Wi-Fi while annai and that
 * trip are open ("whenever the phone is on Wi-Fi"): when the plan changed, parts are missing, or it
 * is a month old; by itself at most once an hour. It names places from the open trip's pack for
 * live mode (choice 7).
 * @typedef {import('./download.js').Manifest} Manifest
 * @typedef {import('./download.js').Progress} Progress
 * @typedef {'plan' | 'missing' | 'old' | null} Why
 * @typedef {{ stops: number, cut: number, manifest: Manifest | null, why: Why, estimate: number, running: (Progress & { scope: string }) | null }} PackStatus
 *   why: what an update would bring (null: nothing, or no pack yet); estimate: about how many bytes
 *   downloading takes now (spec §11.5: shown before downloading)
 */

/** By itself, annai waits for the plan to be quiet this long before it updates the pack. */
export const QUIET_MS = 60_000;
const POKE_MS = 2000;
const AUTO_EVERY_MS = 3_600_000;

export class PackKeeper {
  /** @type {(Progress & { scope: string }) | null} */
  running = null;
  /** @type {Set<() => void>} */
  #listeners = new Set();
  /** @type {AbortController | null} */
  #abort = null;
  /** @type {Promise<Manifest> | null} */
  #job = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;
  /** @type {Map<string, number>} when annai last updated each trip's pack by itself */
  #autoAt = new Map();
  /** @type {import('./read.js').Pack | null} the open trip's pack, for names */
  #named = null;
  /** @type {(() => unknown)[]} */
  #offs;

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace,
   *   agent: { target: string | null, on: (kind: 'open', fn: () => void) => () => unknown },
   *   version: string, connection: () => string, visible?: () => boolean, fetch?: import('./download.js').Fetch,
   *   quietMs?: number, pokeMs?: number, gapMs?: number, now?: () => number }} o
   *   connection: 'wifi', 'cellular', 'unknown' or 'offline' (ui/platform.js connectionOf); fetch: for tests, instead of the traced one
   */
  constructor(o) {
    this.o = o;
    this.#offs = [o.ws.onChange((c) => this.#changed(c)), o.agent.on('open', () => this.#opened())];
    this.#loadNames();
  }

  /** @param {() => void} fn @returns {() => void} */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** What a trip's pack has, and what downloading would take now. @param {string} scope @returns {Promise<PackStatus>} */
  async status(scope) {
    const { ws } = this.o;
    const now = (this.o.now ?? Date.now)();
    const plan = await planFor(ws, scope);
    const manifest = await readManifest(ws, scope);
    const have = new Set((await ws.list(scope, DIR)).map((f) => f.path));
    const missing = plan.parts.filter((p) => !have.has(pathOf(p)));
    const old = manifest !== null && !(now - Date.parse(manifest.at) <= STALE_MS);
    /** @type {Why} */
    const why = !manifest ? null
      : manifest.key !== plan.key ? 'plan'
        : missing.length || manifest.failed.length || manifest.stopped ? 'missing'
          : old ? 'old' : null;
    const guides = manifest?.guides.length ? 0 : likelyGuides(plan);
    return {
      stops: plan.stops.length, cut: plan.cut, manifest, why,
      estimate: why === 'old' ? estimate(plan.parts, likelyGuides(plan)) : estimate(missing, guides),
      running: this.running?.scope === scope ? this.running : null,
    };
  }

  /**
   * Downloads a trip's pack: what it lacks, and what is a month old. One download at a time: a
   * second call while one runs gets that one.
   * @param {string} scope @param {{ auto?: boolean }} [o] auto: annai started it by itself
   * @returns {Promise<Manifest>}
   */
  download(scope, { auto = false } = {}) {
    if (this.#job) return this.#job;
    const { store, ws, version } = this.o;
    const abort = new AbortController();
    this.#abort = abort;
    this.running = { scope, done: 0, total: 0, label: '' };
    this.#emit();
    this.#job = downloadPack({
      ws, scope, version, signal: abort.signal, gapMs: this.o.gapMs, now: this.o.now,
      fetch: this.o.fetch ?? tracedFetch(store, scope, { tool: 'offline-pack' }),
      onProgress: (p) => {
        this.running = { scope, ...p };
        this.#emit();
      },
    }).then(async (m) => {
      const data = { files: m.files.length, bytes: m.bytes, guides: m.guides.length, failed: m.failed.length, stopped: m.stopped, full: m.full, auto };
      await logEvent(store, scope, { type: 'pack.download', actor: 'system', data }).catch(() => {});
      return m;
    }).finally(() => {
      this.#job = null;
      this.#abort = null;
      this.running = null;
      this.#emit();
    });
    return this.#job;
  }

  /** Stops the download that is running; what came stays. */
  stop() {
    this.#abort?.abort();
  }

  /** The connection or the screen changed: maybe the open trip's pack can be brought up to date. */
  poke() {
    this.#schedule(this.o.pokeMs ?? POKE_MS);
  }

  /** The nearest place the open trip's pack names within 500 m, for live mode. @param {{ lat: number, lng: number }} p */
  name(p) {
    return this.#named?.name(p) ?? null;
  }

  dispose() {
    clearTimeout(this.#timer);
    this.stop();
    for (const off of this.#offs) off();
  }

  #emit() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch {
        // a listener that fails changes nothing here
      }
    }
  }

  #opened() {
    // Another trip, or none (this one was removed): its download stops (choice 10).
    if (this.running && this.running.scope !== this.o.agent.target) this.stop();
    this.#loadNames();
    this.poke();
  }

  /** @param {{ scope: string, path: string }} c */
  #changed(c) {
    if (c.scope !== this.o.agent.target) return;
    if (c.path === MANIFEST) this.#loadNames();
    else if (PLAN_FILE.test(c.path) || c.path === '/trip.json') this.#schedule(this.o.quietMs ?? QUIET_MS);
  }

  #loadNames() {
    const trip = this.o.agent.target;
    loadPack(this.o.ws, trip).then((pack) => {
      if (this.o.agent.target === trip) this.#named = pack;
    }, () => {});
  }

  /** @param {number} ms */
  #schedule(ms) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#auto().catch(() => {});
    }, ms);
  }

  async #auto() {
    const scope = this.o.agent.target;
    const now = (this.o.now ?? Date.now)();
    if (!scope || this.#job || this.o.connection() !== 'wifi' || !(this.o.visible?.() ?? true)) return;
    if (now - (this.#autoAt.get(scope) ?? -Infinity) < AUTO_EVERY_MS) return;
    const s = await this.status(scope);
    if (!s.manifest || !s.why) return;
    this.#autoAt.set(scope, now);
    await this.download(scope, { auto: true });
  }
}
```

In `src/plugins/files/index.js`, `filesUnder` becomes:
```js
  /** @param {string} path @param {any} call */
  const filesUnder = async (path, call) => {
    const all = path === '/' || path === ''
      ? [...(call.trip ? await listed(call.trip, '/', '/trip') : []), ...(await listed('me', '/', '/me'))]
      : await (async () => {
        const { scope, path: inner } = where(path, call);
        return listed(scope, inner.endsWith('/') ? inner : `${inner}/`, path.startsWith('/trip') ? '/trip' : '/me');
      })();
    // The offline pack is for the places tools (choice 8): it stays out unless asked for.
    return /^\/?trip\/offline(\/|$)/.test(path) ? all : all.filter((/** @type {any} */ f) => !f.shown.startsWith('/trip/offline/'));
  };
```
The `list` tool's description gains ` The trip's offline pack (/trip/offline/) is left out unless asked for.`

`sw.js` SHELL: add `'/src/core/pack/keeper.js',` in path order.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/pack-keeper.test.js test/unit/plugin-files.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A src/core/pack/keeper.js src/plugins/files/index.js sw.js test/unit/pack-keeper.test.js test/unit/plugin-files.test.js && git commit -m "Keeping the offline pack: what it would take, one download at a time, brought up to date by itself on Wi-Fi once downloaded, and places named for live mode; Shiori's list and search leave it out (spec §11.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 6: The panel, Now's line, the wiring, end to end, and the checklist

**Files:**
- Create: `src/ui/offline-pack.js`, `test/e2e/pack.spec.js`
- Modify: `src/ui/screens/trip.js`, `src/ui/screens/now.js`, `src/ui/screens/trace.js`, `src/app/main.js`, `src/ui/shell.js`, `sw.js` (SHELL), `docs/testing/device-checklist-m5.md`, `README.md`
- Test: `test/unit/ui-pure.test.js`, `test/e2e/pack.spec.js`

**Interfaces:**
- Consumes: Task 5's `PackKeeper`, `PackStatus`; main's `connectionOf` (`src/ui/platform.js`); `bytes`, `relTime` (`src/ui/format.js`); `MAX_BYTES`.
- Produces: `packWords(status, connection): { lines: string[], button: string | null }`; `packPanel(ctx, id): Promise<HTMLElement>` (a region "Offline pack"); `packLine(ctx, id): Promise<HTMLElement | null>` (class `pack-line`); `ctx.pack`; `traceSummary` of `pack.download`; the trace's Web kind includes `pack.download`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/ui-pure.test.js`:
```js
import { packWords } from '../../src/ui/offline-pack.js';

test('the Offline pack panel: the estimate before anything is downloaded, then what it holds and what an update brings (spec §11.5)', () => {
  const base = { stops: 2, cut: 0, manifest: null, why: null, estimate: 120 * 1024, running: null };
  const none = packWords(/** @type {any} */ (base), 'unknown');
  assert.equal(none.button, 'Download (about 120 KB)');
  assert.match(none.lines[0], /^For when there's no connection: places from OpenStreetMap, Wikipedia summaries and Wikivoyage guides, around the plan's 2 stops and along the way between them\./);
  assert.equal(none.lines[1], "Downloading sends the plan's places to OpenStreetMap and Wikipedia, and place names to Wikivoyage.");
  assert.deepEqual(packWords(/** @type {any} */ ({ ...base, stops: 0 }), 'wifi'), { lines: ['The pack follows the plan: once the plan has places, it can be downloaded here.'], button: null });
  assert.deepEqual(packWords(/** @type {any} */ ({ ...base, running: { done: 2, total: 6, label: 'Wikipedia near Nepenthe' } }), 'wifi'), { lines: ['Downloading 3 of 6: Wikipedia near Nepenthe…'], button: null });
  const manifest = { at: new Date().toISOString(), bytes: 1_300_000, files: [{ kind: 'osm', items: 1200 }, { kind: 'wikipedia', items: 40 }, { kind: 'wikivoyage', items: 1 }], guides: [{ title: 'Big Sur' }], failed: [], full: false, stopped: false };
  const done = packWords(/** @type {any} */ ({ ...base, manifest }), 'wifi');
  assert.equal(done.button, null);
  assert.equal(done.lines[0], 'Downloaded just now · 1.2 MB · 1,200 places, 40 Wikipedia summaries, 1 Wikivoyage guide.');
  assert.equal(done.lines[1], 'Guides: Big Sur.');
  assert.equal(done.lines.at(-1), 'On Wi-Fi, annai keeps it up to date by itself while this trip is open.');
  const changed = packWords(/** @type {any} */ ({ ...base, manifest, why: 'plan', estimate: 30 * 1024 }), 'unknown');
  assert.equal(changed.button, 'Update (about 30 KB)');
  assert.ok(changed.lines.includes('The plan changed since.'));
  assert.equal(changed.lines.at(-1), "This browser doesn't tell annai when it is on Wi-Fi, so update it here.");
  const failed = packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, failed: [{ label: 'OpenStreetMap around Nepenthe', why: 'overpass-api.de answered 504.' }] }, why: 'missing' }), 'wifi');
  assert.equal(failed.button, 'Try again (about 120 KB)');
  assert.ok(failed.lines.includes("One part didn't download: OpenStreetMap around Nepenthe (overpass-api.de answered 504)."));
  assert.equal(packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, stopped: true }, why: 'missing' }), 'wifi').button, 'Download the rest (about 120 KB)');
  assert.ok(packWords(/** @type {any} */ ({ ...base, manifest: { ...manifest, full: true } }), 'wifi').lines.includes('It stopped at its 20 MB limit, so it holds only the start of the plan.'));
  assert.ok(packWords(/** @type {any} */ ({ ...base, manifest, cut: 3 }), 'wifi').lines.includes('This plan is longer than a pack holds, so some of the way between stops is left out.'));
  assert.equal(packWords(/** @type {any} */ ({ ...base, manifest, why: 'old' }), 'wifi').button, 'Update (about 120 KB)');
});

test('the trace says what each offline pack download did', () => {
  assert.equal(traceSummary(/** @type {any} */ ({ type: 'pack.download', data: { files: 7, bytes: 120_000, guides: 2, failed: 1, stopped: false, full: false, auto: true } })),
    '7 files · 117 KB · 2 guides · 1 failed · by itself on Wi-Fi');
});
```
(`traceSummary` is already imported in this file.)

`test/e2e/pack.spec.js`:
```js
import { test, expect } from '@playwright/test';
import { openApp, startTrip, writeRecords } from './helpers.js';

// Playwright stands in for OpenStreetMap, Wikipedia and Wikivoyage. In WebKit it can't for a page a
// service worker controls, so the service worker is off here, as in the hosted-archive test.
test.use({ serviceWorkers: 'block' });

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'api-user-agent', 'access-control-allow-methods': 'GET, POST' };
const at = (/** @type {number} */ h) => `2026-11-27T${String(h).padStart(2, '0')}:00:00Z`;
const STOPS = {
  '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: at(17), tz: 'America/Los_Angeles' }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } },
  '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: at(20), tz: 'America/Los_Angeles' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } },
};

/** Stands in for the three services and notes what each was asked. @param {import('@playwright/test').Page} page */
async function services(page) {
  /** @type {{ host: string, url: string, body: string, agent: string }[]} */
  const asked = [];
  const json = (/** @type {any} */ v) => ({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(v) });
  await page.route(/^https:\/\/(overpass-api\.de|overpass\.private\.coffee|en\.wikipedia\.org|en\.wikivoyage\.org)\//, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    asked.push({ host: url.hostname, url: req.url(), body: decodeURIComponent(req.postData() ?? ''), agent: req.headers()['api-user-agent'] ?? '' });
    if (url.hostname.includes('overpass')) {
      return route.fulfill(json({ elements: [{ type: 'node', id: 1, lat: 36.3712, lon: -121.902, tags: { name: 'Bixby Bridge Vista Point', tourism: 'viewpoint' } }, { type: 'node', id: 2, lat: 36.2203, lon: -121.7612, tags: { name: 'Nepenthe', amenity: 'restaurant' } }] }));
    }
    if (url.hostname === 'en.wikipedia.org') return route.fulfill(json({ query: { pages: [{ title: 'Big Sur', coordinates: [{ lat: 36.2704, lon: -121.8081 }], extract: 'Big Sur is a rugged section of the Central Coast of California.' }] } }));
    if (url.searchParams.get('prop') === 'pageprops') {
      return route.fulfill(json({ query: { pages: (url.searchParams.get('titles') ?? '').split('|').map((t) => (t === 'Big Sur' ? { title: t } : { title: t, missing: true })) } }));
    }
    return route.fulfill(json({ query: { pages: [{ title: 'Big Sur', extract: 'Big Sur is a region.\n\n== Eat ==\nNepenthe.' }] } }));
  });
  return asked;
}

test('the offline pack: its size before downloading, then OpenStreetMap, Wikipedia and Wikivoyage into the trip (spec §11.5)', async ({ page }) => {
  const asked = await services(page);
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, { write: STOPS });
  await page.reload();
  const panel = page.getByRole('region', { name: 'Offline pack' });
  await expect(panel).toContainText("For when there's no connection");
  const download = panel.getByRole('button', { name: /^Download \(about \d+(\.\d)? KB\)$/ });
  await expect(download).toBeVisible();
  expect(asked).toEqual([]); // nothing goes before the tap
  await download.click();
  await expect(panel).toContainText(/Downloaded just now · [\d.]+ KB · /, { timeout: 30_000 });
  await expect(panel).toContainText('Guides: Big Sur.');
  await expect(panel.getByRole('link', { name: 'OpenStreetMap contributors' })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  const overpass = asked.filter((a) => a.host === 'overpass-api.de').map((a) => a.body);
  expect(overpass.some((b) => b.includes('around:5000,36.3715,-121.9017'))).toBe(true);
  expect(overpass.some((b) => b.includes('around:3000,36.3715,-121.9017,36.2213,-121.7567'))).toBe(true);
  for (const a of asked.filter((x) => x.host.startsWith('en.'))) expect(a.agent).toMatch(/^annai\/\d+\.\d+\.\d+ \(https:\/\/annai\.guide\)$/);
  for (const a of asked.filter((x) => x.host === 'en.wikivoyage.org')) expect(a.url).not.toMatch(/coord|36\.\d|121\.\d/); // names, never a position (§11.7)
  await expect(page.getByRole('link', { name: /pack\.json|^o[0-9a-z]+\.json$/ })).toHaveCount(0); // the pack's files stay out of the file list
  await page.reload();
  await expect(panel).toContainText(/Downloaded .+ · /);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Now' }).click();
  await expect(page.locator('.pack-line')).toContainText('Offline pack: downloaded');
  await writeRecords(page, trip, { write: { '/plan/mcway.json': { id: 'mcway', title: 'McWay Falls', fixed: false, start: { at: at(21), tz: 'America/Los_Angeles' }, place: { name: 'McWay Falls', lat: 36.158, lng: -121.672 } } } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
  await expect(panel).toContainText('The plan changed since.');
  await expect(panel.getByRole('button', { name: /^Update \(about \d+(\.\d)? KB\)$/ })).toBeVisible();
});

test('a trip with no places in its plan says how the pack works, and offers no download', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Somewhere');
  const panel = page.getByRole('region', { name: 'Offline pack' });
  await expect(panel).toContainText('The pack follows the plan: once the plan has places, it can be downloaded here.');
  await expect(panel.getByRole('button')).toHaveCount(0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL: `src/ui/offline-pack.js` can't be found.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/pack.spec.js`
Expected: FAIL: there is no "Offline pack" region.

- [ ] **Step 3: Write the code**

`src/ui/offline-pack.js`:
```js
import { h } from './dom.js';
import { bytes, relTime } from './format.js';
import { connectionOf } from './platform.js';
import { explainStorageFull } from './storage-full.js';
import { MAX_BYTES } from '../core/pack/download.js';

/**
 * The trip's Offline pack panel and Now's line (spec §11.5): what the pack holds, about how much
 * downloading takes (shown before anything is downloaded), how it stays up to date, and its sources.
 * @typedef {import('../core/pack/keeper.js').PackStatus} PackStatus
 */

/** "1,200 places, 40 Wikipedia summaries, 1 Wikivoyage guide". @param {NonNullable<PackStatus['manifest']>} m */
function holds(m) {
  const n = (/** @type {string} */ kind) => m.files.filter((f) => f.kind === kind).reduce((s, f) => s + f.items, 0);
  const guides = m.guides.length;
  return `${n('osm').toLocaleString('en-US')} places, ${n('wikipedia').toLocaleString('en-US')} Wikipedia summaries, ${guides} Wikivoyage ${guides === 1 ? 'guide' : 'guides'}`;
}

/**
 * What the panel says, and its button.
 * @param {PackStatus} s @param {string} connection what connectionOf says
 * @returns {{ lines: string[], button: string | null }}
 */
export function packWords(s, connection) {
  if (s.running) {
    const r = s.running;
    return { lines: [`Downloading${r.total ? ` ${Math.min(r.done + 1, r.total)} of ${r.total}` : ''}${r.label ? `: ${r.label}` : ''}…`], button: null };
  }
  if (!s.stops) return { lines: ['The pack follows the plan: once the plan has places, it can be downloaded here.'], button: null };
  const about = `about ${bytes(s.estimate)}`;
  const m = s.manifest;
  if (!m) {
    return {
      lines: [
        `For when there's no connection: places from OpenStreetMap, Wikipedia summaries and Wikivoyage guides, around the plan's ${s.stops === 1 ? 'stop' : `${s.stops} stops`} and along the way between them. Shiori's nearby and guide read it first.`,
        "Downloading sends the plan's places to OpenStreetMap and Wikipedia, and place names to Wikivoyage.",
      ],
      button: `Download (${about})`,
    };
  }
  const lines = [`Downloaded ${relTime(Date.parse(m.at))} · ${bytes(m.bytes)} · ${holds(m)}.`];
  if (m.guides.length) lines.push(`Guides: ${m.guides.map((g) => g.title).join(', ')}.`);
  if (m.full) lines.push(`It stopped at its ${bytes(MAX_BYTES)} limit, so it holds only the start of the plan.`);
  if (s.cut) lines.push('This plan is longer than a pack holds, so some of the way between stops is left out.');
  if (m.failed.length) {
    const f = m.failed[0];
    lines.push(`${m.failed.length === 1 ? 'One part' : `${m.failed.length} parts`} didn't download: ${f.label} (${f.why.replace(/[.!?]$/, '')}).`);
  } else if (m.stopped) lines.push('The download was stopped before the end.');
  /** @type {string | null} */
  let button = null;
  if (s.why === 'plan') {
    lines.push('The plan changed since.');
    button = `Update (${about})`;
  } else if (s.why === 'missing') button = `${m.failed.length ? 'Try again' : 'Download the rest'} (${about})`;
  else if (s.why === 'old') {
    lines.push('It is more than a month old.');
    button = `Update (${about})`;
  }
  lines.push(connection === 'unknown' ? "This browser doesn't tell annai when it is on Wi-Fi, so update it here." : 'On Wi-Fi, annai keeps it up to date by itself while this trip is open.');
  return { lines, button };
}

/**
 * The trip's Offline pack panel: what packWords says, its button, Stop while downloading, and the
 * sources' credits. It follows the download as it goes.
 * @param {any} ctx @param {string} id the trip @returns {Promise<HTMLElement>}
 */
export async function packPanel(ctx, id) {
  const box = h('section', { class: 'pack', 'aria-label': 'Offline pack' });
  const keeper = ctx.pack;
  if (!keeper) return box;
  const go = () => {
    keeper.download(id).catch((/** @type {unknown} */ e) => {
      if (explainStorageFull(ctx, e)) return;
      const why = String(/** @type {any} */ (e)?.message ?? e).replace(/[.!?]?$/, '.');
      ctx.notices.card({ tone: 'warn', title: "The offline pack didn't download", body: `${why} What came is kept. Try again in a moment.` });
    });
  };
  const draw = async () => {
    const s = await keeper.status(id);
    const { lines, button } = packWords(s, connectionOf(navigator));
    box.replaceChildren(
      h('h2', { class: 'section', text: 'Offline pack' }),
      ...lines.map((t) => h('p', { class: 'sub', text: t })),
      button || s.running ? h('div', { class: 'acts' },
        button ? h('button', { class: 'btn', type: 'button', onclick: go }, button) : null,
        s.running ? h('button', { class: 'btn', type: 'button', onclick: () => keeper.stop() }, 'Stop') : null) : null,
      h('p', { class: 'sub' }, 'Places © ', h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap contributors'),
        '; summaries from Wikipedia and guides from Wikivoyage, ', h('a', { href: 'https://creativecommons.org/licenses/by-sa/4.0/', target: '_blank', rel: 'noopener' }, 'CC BY-SA'), '.'));
  };
  let drawing = Promise.resolve();
  const off = keeper.onChange(() => {
    if (!box.isConnected) {
      off();
      return;
    }
    drawing = drawing.then(draw).catch(() => {});
  });
  await draw();
  return box;
}

/** Now's line about the pack, with the way to it; null when the plan has no places. @param {any} ctx @param {string} id @returns {Promise<HTMLElement | null>} */
export async function packLine(ctx, id) {
  const s = ctx.pack ? await ctx.pack.status(id).catch(() => null) : null;
  if (!s?.stops) return null;
  const text = !s.manifest ? 'No offline pack for this trip yet.'
    : s.why === 'plan' ? 'The offline pack is from before the plan changed.'
      : `Offline pack: downloaded ${relTime(Date.parse(s.manifest.at))}.`;
  return h('p', { class: 'sub pack-line' }, `${text} `, h('a', { href: `#/trip/${encodeURIComponent(id)}` }, 'Offline pack'));
}
```

`src/ui/screens/trip.js`:
- Import `{ packPanel }` from `'../offline-pack.js'`.
- `const files = await ctx.ws.list(id, '/');` becomes `const files = (await ctx.ws.list(id, '/')).filter((/** @type {any} */ f) => !f.path.startsWith('/offline/')); // the pack has its own panel (choice 8)`.
- Between `extra,` and `fileList(id, files),` add `await packPanel(ctx, id),`.

`src/ui/screens/now.js`:
- Import `{ packLine }` from `'../offline-pack.js'`.
- After the "Next" section (before `latest ? …`), add `await packLine(ctx, id),`.

`src/ui/screens/trace.js`:
- The Web kind becomes `Web: ['net.request', 'pack.download'],`.
- In `traceSummary`, before the `backup` line, add:
```js
  if (e.type === 'pack.download') {
    return [`${d.files ?? 0} files`, bytes(d.bytes ?? 0), `${d.guides ?? 0} guide${d.guides === 1 ? '' : 's'}`, d.failed ? `${d.failed} failed` : null,
      d.full ? 'at its limit' : null, d.stopped ? 'stopped' : null, d.auto ? 'by itself on Wi-Fi' : null].filter(Boolean).join(' · ');
  }
```

`src/app/main.js`:
- Imports: `import { PackKeeper } from '../core/pack/keeper.js';` and `connectionOf` joins the `../ui/platform.js` import.
- After `const awake = keepAwake({ live, ws });`:
```js
  // The offline pack (spec §11.5): downloaded when asked, then kept up to date on Wi-Fi; it names places for live mode.
  const pack = new PackKeeper({ store, ws, agent, version: VERSION, connection: () => connectionOf(navigator), visible: () => document.visibilityState === 'visible' });
  live.namers.push((p) => pack.name(p));
  addEventListener('online', () => pack.poke());
  /** @type {any} */ (navigator).connection?.addEventListener?.('change', () => pack.poke());
  document.addEventListener('visibilitychange', () => pack.poke());
```
- `startShell(…)` gets `pack` after `awake`.

`src/ui/shell.js`: the core type gains `pack?: any` after `awake?: any`.

`sw.js` SHELL: add `'/src/ui/offline-pack.js',` in path order.

`docs/testing/device-checklist-m5.md`, a section before "Battery":
```markdown
## The offline pack
- [ ] On the trip's page, Offline pack shows "Download (about … KB)" before anything is downloaded. On Wi-Fi, tap it: it shows each part as it goes, then "Downloaded just now · … · … places, … Wikipedia summaries, … Wikivoyage guides" and the guides' names.
- [ ] Trace → Web: the requests went to overpass-api.de, en.wikipedia.org and en.wikivoyage.org only, one at a time, about a second apart, and a "pack.download" line sums it up.
- [ ] Android, on Wi-Fi with the trip open: ask Shiori to add a stop to the plan. Within a few minutes the panel says "Downloaded just now" again, without a tap (Trace → Web: "by itself on Wi-Fi").
- [ ] iPhone: the panel says Safari doesn't tell annai when it is on Wi-Fi; after a plan change it offers "Update (about … KB)".
- [ ] Airplane mode, at a stop on the plan: ask "What's around here?" and "Tell me about Big Sur" (or the trip's destination). Shiori answers from the pack, and says it comes from the offline pack; Now says "Near …" a place the pack names.
- [ ] Still in airplane mode, ask about a place far off the plan: she says OpenStreetMap and Wikipedia didn't answer.
```

`README.md`: in the status paragraph, `The offline pack is next.` becomes `And the offline pack: OpenStreetMap places, Wikipedia summaries and Wikivoyage guides along the plan, which Shiori's tools read first, kept up to date on Wi-Fi.`

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/unit/ui-pure.test.js`
Expected: PASS.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/pack.spec.js`
Expected: 4 passed (two tests, two browsers).
Run the whole e2e suite in Docker (the same command without a path).
Expected: all pass in both browsers, but for test/e2e/plugins.spec.js:75 in WebKit, which also fails now and then on main (recorded in 5b).

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A src/ui/offline-pack.js src/ui/screens/trip.js src/ui/screens/now.js src/ui/screens/trace.js src/app/main.js src/ui/shell.js sw.js test/unit/ui-pure.test.js test/e2e/pack.spec.js docs/testing/device-checklist-m5.md README.md && git commit -m "The Offline pack panel on the trip's page, with its size before downloading; Now's line; the trace's sum of each download; end to end in both browsers, and airplane mode on the device checklist (spec §11.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
