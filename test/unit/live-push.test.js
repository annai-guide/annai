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

test('opened while annai is on screen: a catch-up wake at once; another trip\'s waits there; a removed trip\'s and test ones are dropped', async () => {
  const k = await liveKit({ live: false });
  const other = await createTrip(k.ws, { title: 'Tahoe' });
  await k.live.pushNews([{ kind: 'opened', key: `${k.trip}|w-1`, scope: k.trip, watch: 'w-1', body: 'Tea time.', t: at('08:31') }]);
  assert.deepEqual(k.agent.wakes.map((w) => [w.kind, w.text, w.scope]), [['catch-up', 'Catch-up: the user opened the reminder "Tea time." from its notification at 08:31.', undefined]]);
  await k.live.pushNews([
    { kind: 'opened', key: `${other}|w-2`, scope: other, watch: 'w-2', body: 'Skis.', t: at('08:32') },
    { kind: 'opened', key: 'trip-gone|w-3', scope: 'trip-gone', watch: 'w-3', body: 'Gone.', t: at('08:32') },
    { kind: 'opened', key: 'hello|x', scope: '', test: true, body: 'Notifications are on.', t: at('08:32') },
  ]);
  assert.equal(k.agent.wakes.length, 2);
  assert.equal(k.agent.wakes[1].scope, other);
  assert.match(k.agent.wakes[1].text, /"Skis\."/);
});

test("a notification for a reminder annai already said on screen is a double: pushNews names it, so the page closes it", async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  const v = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('11:00') }, fallback: 'Walk.' });
  await k.to(at('10:00'));
  const doubles = await k.live.pushNews([
    { kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:00:30') },
    { kind: 'shown', key: `${k.trip}|${v.id}`, scope: k.trip, watch: v.id, t: at('10:00:30') },
  ]);
  assert.deepEqual(doubles, [`${k.trip}|${w.id}`]);
});

test('while another trip opens, the list never pairs the new trip with the old plan: the plan and the conversation are read together', async () => {
  const k = await liveKit({ plan: { nepenthe: NEP } });
  const other = await createTrip(k.ws, { title: 'Carmel' });
  await k.ws.write(other, '/plan/tea.json', { id: 'tea', ...TEA }, { author: 'user' });
  await k.to(at('11:00'));
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
  const away = await k.live.pushNews([{ kind: 'shown', key: `${k.trip}|${v.id}`, scope: k.trip, watch: v.id, t: at('10:05:30') }]);
  assert.deepEqual(away, []);
  k.sensors.visible(true); // the catch-up says both
  await k.settle();
  assert.equal(k.agent.wakes.at(-1)?.kind, 'catch-up');
  const later = await k.live.pushNews([{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:20:10') }]);
  assert.deepEqual(later, [`${k.trip}|${w.id}`]);
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
  const doubles = await live.pushNews([{ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, t: at('10:30:20') }]);
  assert.deepEqual(doubles, []);
  live.dispose();
});
