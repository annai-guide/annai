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
  assert.equal(m.places, 5); // each place once, though the areas overlap
  assert.equal(m.summaries, 4);
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
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, gapMs: 0, busyMs: 1 });
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

test("a service that doesn't answer in time is a failure that says so; a stop while waiting is a stop", async () => {
  const { ws, trip } = await packTrip();
  const hang = (/** @type {string} */ _url, /** @type {any} */ init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const slow = services({ overpass: hang });
  const m = await downloadPack({ ws, scope: trip, fetch: slow.fetch, version: V, gapMs: 0, answerMs: 30 });
  assert.equal(m.failed[0].why, "OpenStreetMap didn't answer (overpass.private.coffee didn't answer in time).");
  assert.equal(m.stopped, true); // three in a row
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 30);
  const stopped = await downloadPack({ ws, scope: trip, fetch: services({ overpass: hang }).fetch, version: V, gapMs: 0, signal: abort.signal });
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.failed, []);
});

test("Overpass's 429 (too many requests) is waited out once before the other server is asked", async () => {
  const { ws, trip } = await packTrip();
  let busy = 1;
  const { fetch, asked } = services({ overpass: (url, init) => (url.includes('overpass-api.de') && busy-- > 0 ? new Response('', { status: 429 }) : { elements: [] }) });
  const m = await downloadPack({ ws, scope: trip, fetch, version: V, gapMs: 0, busyMs: 40 });
  const first = asked.filter((a) => a.url.includes('overpass')).slice(0, 2);
  assert.deepEqual(first.map((a) => new URL(a.url).hostname), ['overpass-api.de', 'overpass-api.de']);
  assert.ok(first[1].at - first[0].at >= 35, 'it waited');
  assert.ok(!asked.some((a) => a.url.includes('private.coffee')));
  assert.deepEqual(m.failed, []);
});
