import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, fakeAgent, at, iso, LA, MONTEREY, RIVER_INN, NEPENTHE } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { createTrip, setTripStatus } from '../../src/core/scopes.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { Registry } from '../../src/core/registry.js';

const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
const TEA = { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } };
const BIX = { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } };

/** The service worker's news reaching annai on screen, once. @param {any} live @param {any[]} list @returns {Promise<string[]>} */
const arrives = (live, list) => {
  const was = live.news;
  live.news = async () => { live.news = was; return list; };
  return live.newsArrived();
};

test('what a closed annai can still say: time watches in every conversation, and the open trip\'s "coming up" and "leave soon"; never a place (spec §11.6)', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP, tea: TEA, bixby: BIX } });
  const tea = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  const home = await k.live.setWatch('me', { when: { type: 'time', at: iso('11:00') }, fallback: 'Call home.' });
  await k.live.setWatch(k.trip, { when: { type: 'every', minutes: 30 }, fallback: 'Look around.' });
  await k.live.setWatch(k.trip, { when: { type: 'enter', lat: NEPENTHE.lat, lng: NEPENTHE.lng }, fallback: 'Here.' });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('13:00') }, fallback: 'Gone by then.', expires: iso('12:00') });
  const list = await k.live.reminders();
  assert.deepEqual(list?.map((r) => [r.key, r.scope, r.watch, r.due, r.text]), [
    [`${k.trip}|${tea.id}`, k.trip, tea.id, at('10:00'), 'Tea time.'],
    [`me|${home.id}`, 'me', home.id, at('11:00'), 'Call home.'],
    [`${k.trip}|plan:nepenthe:leave|${at('12:00')}`, k.trip, 'plan:nepenthe:leave', at('11:09'), 'Leave soon: Lunch at Nepenthe at 12:00.'], // from Bixby, the stop before
    [`${k.trip}|plan:tea:coming-up|${at('16:00')}`, k.trip, 'plan:tea:coming-up', at('15:45'), 'In 15 min: Tea at the inn at 16:00.'],
  ]);
});

test('before live mode has loaded, it says nothing rather than an empty list', async () => {
  const k = await liveKit();
  const fresh = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA });
  assert.equal(await fresh.reminders(), null);
  await fresh.start();
  assert.deepEqual(await fresh.reminders(), []);
  fresh.dispose();
});

test('"leave soon" is when the phone itself would say it: from where annai last saw the user; once there, none', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  const leave = async () => (await k.live.reminders())?.find((r) => r.watch === 'plan:nepenthe:leave')?.due ?? null;
  assert.equal(await leave(), at('11:30'), 'no position and no stop before: half an hour before');
  await k.fix(at('09:00'), MONTEREY);
  const far = await leave();
  await k.fix(at('09:01'), RIVER_INN);
  const near = await leave();
  assert.ok(far !== null && near !== null && far < near, `${far} < ${near}`);
  await k.fix(at('09:02'), NEPENTHE);
  assert.equal(await leave(), null, 'already there');
});

test('a fired time watch and a spent plan reminder leave the list; an item moved later comes back under a new key', async () => {
  const k = await liveKit({ plan: { tea: TEA }, live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.to(at('10:00'));
  assert.equal((await k.live.reminders())?.some((r) => r.watch === w.id), false);
  await k.to(at('15:45'));
  assert.deepEqual((await k.live.reminders())?.map((r) => r.key), []);
  await k.ws.write(k.trip, '/plan/tea.json', { id: 'tea', ...TEA, start: { at: iso('17:00'), tz: LA } }, { author: 'user' });
  await k.settle();
  assert.deepEqual((await k.live.reminders())?.map((r) => [r.key, r.due]), [[`${k.trip}|plan:tea:coming-up|${at('17:00')}`, at('16:45')]]);
});

test('onReminders is told whenever the list may have changed', async () => {
  const k = await liveKit({ live: false });
  let told = 0;
  const off = k.live.onReminders(() => { told++; });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  assert.ok(told >= 1, 'set');
  let before = told;
  await k.live.cancelWatch(k.trip, w.id);
  assert.ok(told > before, 'cancelled');
  before = told;
  await k.ws.write(k.trip, '/plan/tea.json', { id: 'tea', ...TEA }, { author: 'user' });
  await k.settle();
  assert.ok(told > before, 'the plan changed');
  before = told;
  await k.live.forget(k.trip);
  assert.ok(told > before, 'forgotten');
  off();
  before = told;
  await k.live.setWatch('me', { when: { type: 'time', at: iso('11:00') }, fallback: 'x' });
  assert.equal(told, before, 'no longer told');
});

test('forget: a removed trip\'s watches leave live mode at once (spec §4.9)', async () => {
  const k = await liveKit({ live: false });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.live.setWatch('me', { when: { type: 'time', at: iso('11:00') }, fallback: 'Call home.' });
  k.agent.opened(null);
  await k.live.forget(k.trip);
  assert.deepEqual((await k.live.reminders())?.map((r) => r.scope), ['me']);
  await k.to(at('10:30'));
  assert.equal(k.agent.wakes.length, 0, 'nothing of it fires');
});

test('opened from its notification while annai was closed: the catch-up wake says so, and that the notification was shown (spec §11.6)', async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.settle(); // the watch's own file change is looked at before annai closes
  k.live.dispose();
  await k.clock.advanceTo(at('10:05'));
  const key = `${k.trip}|${w.id}`;
  /** @type {import('../../src/core/live/live.js').PushNews[]} */
  const news = [
    { kind: 'shown', key, scope: k.trip, watch: w.id, at: at('10:00'), t: at('10:00:30') },
    { kind: 'opened', key, scope: k.trip, watch: w.id, title: 'Big Sur', body: 'Tea time.', t: at('10:05') },
  ];
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA, news: async () => news.splice(0) });
  await again.start();
  await again.settled();
  assert.equal(k.agent.wakes.length, 1);
  const wake = k.agent.wakes[0];
  assert.equal(wake.kind, 'catch-up');
  assert.match(wake.text, /^Catch-up: annai was closed for /);
  assert.ok(wake.text.includes('The user opened the reminder "Tea time." from its notification at 10:05.'), wake.text);
  assert.ok(wake.text.includes('(late by 5 min: annai was closed; its notification was shown at 10:00)'), wake.text);
  assert.deepEqual((await k.events(['push.shown', 'push.opened'])).map((e) => [e.type, e.data.watch]), [['push.shown', w.id], ['push.opened', w.id]]);
  again.dispose();
});

test("only a notification shown for this firing counts as reaching the user: one shown before it came due (an earlier firing's) doesn't (review A8)", async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.settle();
  k.live.dispose();
  await k.clock.advanceTo(at('10:05'));
  /** @type {import('../../src/core/live/live.js').PushNews[]} */
  const news = [{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, at: at('09:00'), t: at('09:00:30') }];
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA, news: async () => news.splice(0) });
  await again.start();
  await again.settled();
  assert.deepEqual(k.agent.wakes[0].fallbacks.map((/** @type {any} */ f) => f.text), ['Tea time.']);
  assert.ok(!k.agent.wakes[0].text.includes('its notification was shown'), k.agent.wakes[0].text);
  again.dispose();
});

test("a notification for this firing counts though the phone's clock had it a little early: matched by the time it was for, or shown within a minute of it (review A8)", async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  const v = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Stretch.' });
  await k.settle();
  k.live.dispose();
  await k.clock.advanceTo(at('10:05'));
  /** @type {import('../../src/core/live/live.js').PushNews[]} */
  const news = [
    { kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, at: at('10:00'), t: at('09:58') },
    { kind: 'shown', key: `${k.trip}|${v.id}`, scope: k.trip, watch: v.id, t: at('09:59:40') },
  ];
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA, news: async () => news.splice(0) });
  await again.start();
  await again.settled();
  assert.deepEqual(k.agent.wakes[0].fallbacks, []);
  again.dispose();
});

test("a reminder whose notification the phone already showed has reached the user: its wake owes no fallback for it (emulator pass m6 #16)", async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  const v = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Stretch.' });
  await k.settle();
  k.live.dispose();
  await k.clock.advanceTo(at('10:05'));
  /** @type {import('../../src/core/live/live.js').PushNews[]} */
  const news = [{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, at: at('10:00'), t: at('10:00:30') }];
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA, news: async () => news.splice(0) });
  await again.start();
  await again.settled();
  assert.equal(k.agent.wakes.length, 1);
  assert.deepEqual(k.agent.wakes[0].fallbacks.map((/** @type {any} */ f) => f.text), ['Stretch.']);
  again.dispose();
});

test('opened while annai is on screen: a catch-up wake at once; another trip\'s waits there; a removed trip\'s and test ones are dropped', async () => {
  const k = await liveKit({ live: false });
  const other = await createTrip(k.ws, { title: 'Tahoe' });
  await arrives(k.live, [{ kind: 'opened', key: `${k.trip}|w-1`, scope: k.trip, watch: 'w-1', body: 'Tea time.', t: at('08:31') }]);
  assert.deepEqual(k.agent.wakes.map((w) => [w.kind, w.text, w.scope]), [['catch-up', 'Catch-up: the user opened the reminder "Tea time." from its notification at 08:31.', undefined]]);
  await arrives(k.live, [
    { kind: 'opened', key: `${other}|w-2`, scope: other, watch: 'w-2', body: 'Skis.', t: at('08:32') },
    { kind: 'opened', key: 'trip-gone|w-3', scope: 'trip-gone', watch: 'w-3', body: 'Gone.', t: at('08:32') },
    { kind: 'opened', key: 'hello|x', scope: '', test: true, body: 'Notifications are on.', t: at('08:32') },
  ]);
  assert.equal(k.agent.wakes.length, 2);
  assert.equal(k.agent.wakes[1].scope, other);
  assert.match(k.agent.wakes[1].text, /"Skis\."/);
});

test("a notification for a reminder annai already said on screen is a double: the news names it, so the page closes it", async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  const v = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('11:00') }, fallback: 'Walk.' });
  await k.to(at('10:00'));
  const doubles = await arrives(k.live, [
    { kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:00:30') },
    { kind: 'shown', key: `${k.trip}|${v.id}`, scope: k.trip, watch: v.id, t: at('10:00:30') },
  ]);
  assert.deepEqual(doubles, [`${k.trip}|${w.id}`]);
});

test('while another trip opens, the list never pairs the new trip with the old plan: the plan and the conversation are read together', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP }, start: at('08:30', '2026-11-26') }); // the day before: none happening, so play goes with the open one
  const other = await createTrip(k.ws, { title: 'Carmel', start: '2026-11-29', end: '2026-11-29' });
  await k.ws.write(other, '/plan/tea.json', { id: 'tea', ...TEA }, { author: 'user' });
  await k.to(at('11:00', '2026-11-26'));
  assert.ok((await k.live.reminders())?.some((r) => r.scope === k.trip && r.watch.startsWith('plan:nepenthe:')));
  k.agent.target = other; // the Agent has started opening Carmel; its "open" event comes once its log is read
  const list = /** @type {any[]} */ (await k.live.reminders());
  assert.ok(!list.some((r) => r.scope === other && r.watch.startsWith('plan:nepenthe:')), JSON.stringify(list));
  assert.ok(list.some((r) => r.scope === other && r.watch.startsWith('plan:tea:')), JSON.stringify(list));
  k.live.dispose();
});

test('a reminder said in a catch-up counts as said: its notification arriving later is a double; one shown while annai was away is not', async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  const v = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:05') }, fallback: 'Walk.' });
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('10:20'));
  // While away, Walk's notification was shown; Tea's was held up at the push service.
  const away = await arrives(k.live, [{ kind: 'shown', key: `${k.trip}|${v.id}`, scope: k.trip, watch: v.id, t: at('10:05:30') }]);
  assert.deepEqual(away, []);
  k.sensors.visible(true); // the catch-up says both
  await k.settle();
  assert.equal(k.agent.wakes.at(-1)?.kind, 'catch-up');
  const later = await arrives(k.live, [{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:20:10') }]);
  assert.deepEqual(later, [`${k.trip}|${w.id}`]);
});

// remind-first-next, Call 2: a catch-up makes its firings as it delivers them, so one that ends as the page goes out of view says them to nobody on screen:
// they don't count as said, and a notification for one that comes later (held back at the push service) is shown, not closed as a double. On a241fd148 the
// first look made them, with the page in view, and they counted.
test('a reminder in a catch-up that ended with the page out of view was not said on screen: its notification arriving later is no double', async () => {
  const k = await liveKit();
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('10:20'));
  k.sensors.visible(true); // the catch-up finds it due and waits for a fix
  await k.settle();
  assert.equal(k.agent.wakes.length, 0);
  k.sensors.visible(false); // gone again before any fix: the catch-up ends, out of view
  await k.settle();
  assert.equal(k.agent.wakes.at(-1)?.kind, 'catch-up');
  assert.deepEqual(k.live.given(), [], 'not said on screen');
  const later = await arrives(k.live, [{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:20:10') }]);
  assert.deepEqual(later, []);
  k.live.dispose();
});

// said-mark-b (the design check's route B): the said mark has one write point, #made with the page in view. With no data a catch-up that ends out of
// view gives its reminders as cards at once (the chat keeps them), but no one saw them, so they don't count as said: the relay's copy, sent after the
// traveller has left, is the only notice that reached them, and it is shown (with sound), not closed as a double.
test('an offline glance that ends out of view gave the card but did not say it: the relay\'s copy shown later is no double', async () => {
  const k = await liveKit();
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('10:20'));
  k.sensors.online(false);
  k.sensors.visible(true); // back with no data: the catch-up finds it due and waits for a fix
  await k.settle();
  assert.deepEqual(k.agent.reminders, []);
  k.sensors.visible(false); // gone before any fix: annai gives the card at once, out of view
  await k.settle();
  assert.deepEqual(k.agent.reminders.map((r) => r.text), ['Tea time.']);
  assert.deepEqual(k.live.given(), [], 'no one saw the card: not said');
  const later = await arrives(k.live, [{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:20:30') }]);
  assert.deepEqual(later, []);
  k.live.dispose();
});

test("archiving a trip takes its reminders out of what a closed annai can say at once; unarchiving brings them back", async () => {
  const k = await liveKit({ plan: { tea: TEA } });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  /** @type {string[]} */
  const told = [];
  k.live.onReminders((level) => told.push(level));
  const scopes = async () => [...new Set(((await k.live.reminders()) ?? []).map((r) => r.watch))];
  assert.deepEqual(await scopes(), [w.id, 'plan:tea:coming-up']);
  await setTripStatus(k.store, k.trip, 'archived');
  await k.live.tripsChanged();
  assert.deepEqual(await scopes(), []);
  assert.ok(told.includes('urgent'));
  await setTripStatus(k.store, k.trip, 'active');
  await k.live.tripsChanged();
  assert.deepEqual(await scopes(), [w.id, 'plan:tea:coming-up']);
  k.live.dispose();
});

test("an archived trip's watch file that changes doesn't bring its watches back: they wait until it is unarchived", async () => {
  const k = await liveKit();
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await setTripStatus(k.store, k.trip, 'archived');
  await k.live.tripsChanged();
  const later = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:30') }, fallback: 'Scones.' }); // written in the archived trip
  await k.settle();
  assert.deepEqual((await k.live.reminders()) ?? [], []);
  assert.ok(!k.live.held.some((key) => key.includes(later.id)), k.live.held.join(', '));
  await k.to(at('10:31'));
  assert.equal(k.agent.wakes.length, 0, 'nothing of it fires');
  await setTripStatus(k.store, k.trip, 'active');
  await k.live.tripsChanged();
  await k.settle();
  assert.equal((await k.events(['trigger.fired'])).length, 2, 'unarchived, both come back, and fire late');
  k.live.dispose();
});

test('annai starting off screen says nothing on screen: its catch-up firings are not said, so their notifications are no doubles (fix pass L3)', async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  k.live.dispose();
  // annai starts again at 10:30 in the background (a notification tap that hasn't brought it forward yet).
  const clock = new ManualClock(at('10:30'));
  const agent = fakeAgent(k.trip);
  const registry = new Registry();
  registry.add('test', 'sensor', { kind: 'visibility', start: (/** @type {(v: boolean) => void} */ emit) => { emit(false); return () => {}; } });
  const live = new Live({ store: k.store, ws: k.ws, registry, agent, clock, timeZone: () => LA });
  await live.start();
  await live.settled();
  assert.equal(live.shown, false);
  assert.ok(agent.wakes.some((x) => x.kind === 'catch-up'), 'the catch-up still tells Shiori');
  const doubles = await arrives(live, [{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:30:20') }]);
  assert.deepEqual(doubles, []);
  live.dispose();
});

test('a "coming up" reminder carries its item\'s start, so the phone can count the minutes left when it shows (the emulator pass, m6 #11)', async () => {
  const k = await liveKit({ plan: { tea: TEA, nepenthe: NEP } });
  const list = /** @type {any[]} */ (await k.live.reminders());
  assert.equal(list.find((r) => r.watch === 'plan:tea:coming-up')?.start, at('16:00'));
  assert.equal(list.find((r) => r.watch === 'plan:nepenthe:leave')?.start, undefined, '"leave soon" counts no minutes to the start');
  k.live.dispose();
});

// The emulator pass: a reminder annai had given in its catch-up, held back by the phone, popped up 6 minutes later.
test('a notification the service worker found stale is a double, whoever said it; a catch-up closes the doubles it reads', async () => {
  /** @type {string[][]} */
  const closed = [];
  const k = await liveKit({ live: false });
  const fresh = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA, close: (keys) => { closed.push(keys); },
    news: async () => [{ kind: 'shown', key: `${k.trip}|w-gone`, scope: k.trip, watch: 'w-gone', stale: true, t: at('10:00') }] });
  await fresh.start();
  assert.deepEqual(closed, [[`${k.trip}|w-gone`]], 'the catch-up at start read it, and closed it');
  const doubles = await arrives(fresh, [{ kind: 'shown', key: `${k.trip}|w-old`, scope: k.trip, watch: 'w-old', stale: true, t: at('10:01') }]);
  assert.deepEqual(doubles, [`${k.trip}|w-old`]);
  fresh.dispose();
});

test("the user's shape on the live engine: home four days before a trip flown to, nothing fires for the stay or the tour on screen, and the push relay holds the tour's copy, counted from the stay (it said \"Leave in about 15 min\" for a check-in 3300 km away)", async () => {
  // Made-up names: a flight out of SFO landing on the other coast at 17:30 its time, after the 16:00 check-in of a stay 3300 km away; a tour near it at 19:00.
  const NY = 'America/New_York';
  const FAR = { lat: 40.3, lng: -83.6 };
  const plan = {
    out: { title: 'Flight out', kind: 'flight', fixed: true, start: { at: '2026-11-27T09:00:00-08:00', tz: LA }, end: { at: '2026-11-27T17:30:00-05:00', tz: NY }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 } },
    inn: { title: 'Check in: Harbor Inn', fixed: true, start: { at: '2026-11-27T16:00:00-05:00', tz: NY }, place: { name: 'Harbor Inn', ...FAR }, booking: '/trip/bookings/inn.json' },
    tour: { title: 'Lighthouse tour', fixed: true, start: { at: '2026-11-27T19:00:00-05:00', tz: NY }, place: { name: 'Old Lighthouse', lat: 40.3, lng: -83.55 } },
  };
  const bookings = { inn: { id: 'inn', kind: 'lodging', status: 'confirmed', source: '/trip/files/inn.pdf', title: 'Harbor Inn' } };
  const k = await liveKit({ plan, bookings, start: at('08:00', '2026-11-23') });
  await k.fix(at('08:01', '2026-11-23'), MONTEREY);
  const relay = async () => ((await k.live.reminders()) ?? []).filter((r) => r.watch.startsWith('plan:'));
  // The relay holds two copies. The flight out, which the traveller drives to, counts from the phone's last position. The tour, after the flight,
  // counts from the plan's stop before it, the stay 4.24 km away (8 min by car, and the 15 of the lead: 18:37), though the phone's last position
  // is at home, a flight away, and so counts as none (the review's F1: the relay held nothing for it). It is never due before the flight lands
  // (17:30); that floor is pinned in live-plan-watches.
  const held = await relay();
  assert.deepEqual(held.map((r) => r.watch), ['plan:out:leave', 'plan:tour:leave']);
  assert.equal(held[1].due, Date.parse('2026-11-27T18:37:00-05:00'));
  // The days until the flight, at home and on screen (the user's report came at 20:44 on the Monday), and fresh fixes at home either side of the
  // tour's copy's time, 18:30 and 18:40 New York time: nothing of the stay or the tour fires on screen from a position a flight away.
  for (const t of [at('20:44', '2026-11-23'), at('20:00', '2026-11-24'), at('20:00', '2026-11-25'), at('20:00', '2026-11-26'), Date.parse('2026-11-27T18:30:00-05:00'), Date.parse('2026-11-27T18:40:00-05:00')]) await k.fix(t, MONTEREY);
  const fired = (await k.events(['trigger.fired'])).map((e) => String(e.data.watch));
  assert.deepEqual(fired.filter((w) => w.startsWith('plan:inn:') || w.startsWith('plan:tour:')), []);
  k.live.dispose();
  // A diner between the stay and the tour, 3 km from the tour, is the tour's stop before: its copy counts from there (6 min and the 15: 18:39).
  const diner = { title: 'Diner', fixed: true, start: { at: '2026-11-27T18:00:00-05:00', tz: NY }, place: { name: 'Corner Diner', lat: 40.327, lng: -83.55 } };
  const k2 = await liveKit({ plan: { ...plan, diner }, bookings, start: at('08:00', '2026-11-23') });
  await k2.fix(at('08:01', '2026-11-23'), MONTEREY);
  const dined = ((await k2.live.reminders()) ?? []).filter((r) => r.watch.startsWith('plan:'));
  assert.equal(dined.find((r) => r.watch === 'plan:tour:leave')?.due, Date.parse('2026-11-27T18:39:00-05:00'));
  k2.live.dispose();
});

test("a flight's \"leave soon\" at the push relay is when the phone would say it: 2 h before the departure, less the drive and the lead", async () => {
  const SFO = { lat: 37.6213, lng: -122.379 };
  const k = await liveKit({ plan: { fly: { title: 'Flight home', kind: 'flight', fixed: true, start: { at: iso('14:05'), tz: LA }, place: { name: 'SFO', ...SFO } } } });
  await k.fix(at('08:31'), { lat: SFO.lat + 25_000 / ((6_371_000 * Math.PI) / 180), lng: SFO.lng }); // 25 km north: about 40 min by car
  const leave = ((await k.live.reminders()) ?? []).find((r) => r.watch === 'plan:fly:leave');
  assert.equal(leave?.due, at('11:10')); // 14:05 − 120 − 40 − 15
  k.live.dispose();
});
