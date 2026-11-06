import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveKit, at, iso, off, LA, MONTEREY, BIXBY, NEPENTHE } from './live-kit.js';
import { removeTrip, setTripStatus, ME } from '../../src/core/scopes.js';
import { record } from '../../src/core/agent/log.js';
import { ManualClock } from '../../src/core/live/clock.js';

const NEP = { title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, end: { at: iso('13:15'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
const BIX = { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } };
const LEAVE = 'plan:nepenthe:leave';
const TODAY = { start: '2026-11-27', end: '2026-11-28' };
const said = (/** @type {any} */ k) => k.agent.reminders.map((/** @type {any} */ r) => [r.watch, r.scope]);

/** The trip open and the road under way, moving fast. @param {any} k */
async function rolling(k) {
  await k.drive(MONTEREY, off(MONTEREY, 0, -6000), at('09:00'), at('09:05'));
  assert.equal(k.live.activity, 'moving-fast');
}

test("quick chat during the trip: open changes, play doesn't", async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  await rolling(k);
  const stop = k.live.stop;
  const points = (await k.events(['location'])).length;
  assert.ok(points > 0);
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  assert.equal(k.live.play, k.trip);
  assert.equal(k.live.activity, 'moving-fast');
  assert.deepEqual(k.live.stop, stop, 'the same stop: nothing about the drive changed');
  await k.drive(off(MONTEREY, 0, -6000), off(MONTEREY, 0, -12_000), at('09:05:05'), at('09:10'));
  assert.equal(k.live.activity, 'moving-fast');
  assert.ok((await k.events(['location'])).length > points, 'points go on into the trip');
  assert.deepEqual(await k.events(['location'], chat), []);
  await k.to(at('11:09'));
  assert.deepEqual(said(k).filter(([w]) => w === LEAVE), [[LEAVE, k.trip]]);
  const wake = k.agent.wakes.find((w) => /time to leave soon/.test(w.text));
  assert.equal(wake.scope, k.trip);
  assert.deepEqual(await k.events(['trigger.fired'], chat), []);
  assert.deepEqual(await k.events(['location', 'error', 'wake'], chat), []);
  assert.equal((await k.events(['trigger.fired'])).filter((e) => e.data.watch === LEAVE).length, 1);
});

test("a quick chat's own GPS and time watches still fire there", async () => {
  const k = await liveKit();
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  assert.equal(k.live.play, k.trip);
  await k.live.setWatch(chat, { when: { type: 'enter', lat: BIXBY.lat, lng: BIXBY.lng, radius: 300 }, fallback: 'Bixby.' });
  await k.live.setWatch(chat, { when: { type: 'time', at: iso('09:00') }, fallback: 'Tea.' });
  await k.fix(at('08:40'), off(BIXBY, 0, 2000));
  await k.fix(at('08:45'), BIXBY);
  assert.deepEqual((await k.events(['trigger.fired'], chat)).map((e) => e.data.type), ['enter']);
  await k.to(at('09:00'));
  assert.deepEqual((await k.events(['trigger.fired'], chat)).map((e) => e.data.type), ['enter', 'time']);
});

test("the trip in play's own GPS watch fires while a quick chat is open", async () => {
  const k = await liveKit();
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  await k.live.setWatch(k.trip, { when: { type: 'enter', lat: BIXBY.lat, lng: BIXBY.lng, radius: 300 }, fallback: 'Bixby.' });
  await k.fix(at('08:40'), off(BIXBY, 0, 2000));
  await k.fix(at('08:45'), BIXBY);
  assert.deepEqual((await k.events(['trigger.fired'])).map((e) => e.data.type), ['enter']);
  assert.deepEqual(said(k).map(([, scope]) => scope), [k.trip]);
});

test("what the plan knows has fired is the play's: arrived there during a quick chat, it isn't running late", async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  await k.stay(NEPENTHE, at('11:35'), at('11:55'), 30);
  assert.ok((await k.events(['trigger.fired'])).some((e) => e.data.watch === 'plan:nepenthe:arrived'));
  await k.fix(at('12:05'), off(NEPENTHE, 0, 3000));
  assert.deepEqual((await k.events(['trigger.fired'])).filter((e) => e.data.watch === 'plan:nepenthe:late'), []);
});

test('another open trip that is not happening: play stays', async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  const later = await k.chat('Kyoto', { start: '2027-04-03', end: '2027-04-10' });
  k.agent.opened(later);
  await k.settle();
  assert.equal(k.live.play, k.trip);
  const past = await k.chat('Last year', { start: '2025-04-03', end: '2025-04-10' });
  k.agent.opened(past);
  await k.settle();
  assert.equal(k.live.play, k.trip);
});

test('two happening: the one last talked in, whichever is open, whose plan reminds alone; time watches fire for both', async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  const other = await k.chat('Side trip', TODAY);
  await k.ws.write(other, '/plan/tea.json', { id: 'tea', title: 'Tea at Bixby', fixed: true, start: { at: iso('11:00'), tz: LA }, place: { name: 'Tea', ...NEPENTHE } }, { author: 'user' });
  const chat = await k.chat('Ramen');
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: at('08:30') });
  k.agent.opened(other);
  await k.settle();
  assert.equal(k.live.play, k.trip, 'looking at the other moves nothing');
  await record(k.store, other, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: at('08:31') });
  k.agent.opened(chat);
  await k.settle();
  assert.equal(k.live.play, other, 'last talked in');
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: at('08:32') });
  k.agent.opened(null);
  await k.settle();
  assert.equal(k.live.play, k.trip, 'a later line moves it');
  k.agent.opened(chat);
  await k.settle();
  await k.live.setWatch(other, { when: { type: 'time', at: iso('09:00') }, fallback: 'Other.' });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:01') }, fallback: 'Mine.' });
  await k.to(at('11:09'));
  assert.deepEqual((await k.events(['trigger.fired'], other)).map((e) => e.data.type), ['time'], "the other's plan waits; its time watch fired");
  const fired = (await k.events(['trigger.fired'])).map((e) => e.data.watch);
  assert.ok(fired.includes(LEAVE));
});

test('ties in last talked in: the later start, then the id, so the choice is stable', async () => {
  const k = await liveKit();
  const a = await k.chat('Started earlier', { start: '2026-11-26', end: '2026-11-28' });
  const b = await k.chat('Started later', { start: '2026-11-27', end: '2026-11-28' });
  k.agent.opened(null);
  await k.settle();
  const later = [k.trip, b].sort().at(-1);
  assert.equal(k.live.play, later, 'nobody has talked: same start, the higher id');
  assert.notEqual(k.live.play, a);
});

test('nothing open, nothing happening: no point is kept, a time watch fires', async () => {
  const k = await liveKit({ start: at('08:30', '2026-12-05') });
  k.agent.opened(null);
  await k.settle();
  assert.equal(k.live.play, null);
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:00', '2026-12-05') }, fallback: 'Tea.' });
  await k.fix(at('08:40', '2026-12-05'), MONTEREY);
  await k.fix(at('08:45', '2026-12-05'), BIXBY);
  assert.deepEqual(await k.events(['location']), []);
  assert.deepEqual(await k.events(['location'], ME), []);
  await k.to(at('09:00', '2026-12-05'));
  assert.deepEqual((await k.events(['trigger.fired'])).map((e) => e.data.type), ['time']);
});

test('nothing open, a trip happening: it is in play', async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  k.agent.opened(null);
  await k.settle();
  assert.equal(k.live.play, k.trip);
  await k.fix(at('08:40'), MONTEREY);
  assert.equal((await k.events(['location'])).length, 1);
  await k.to(at('11:09'));
  assert.deepEqual(said(k), [[LEAVE, k.trip]]);
});

test('midnight alarm: GPS off, no watches, a trip starting tomorrow: its first reminder comes with nothing else happening', async () => {
  const k = await liveKit({ live: false, start: at('20:00', '2026-11-26'), plan: { bixby: BIX, nepenthe: NEP } });
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  assert.equal(k.live.play, chat, 'the trip starts tomorrow');
  await k.to(at('23:59', '2026-11-26'));
  assert.equal(k.live.play, chat);
  await k.to(at('00:00'));
  assert.equal(k.live.play, k.trip, 'the day turned');
  await k.to(at('11:09'));
  assert.deepEqual(said(k), [[LEAVE, k.trip]]);
});

test('a trip ending at midnight lets go, with nothing else happening', async () => {
  const k = await liveKit({ live: false, start: at('20:00', '2026-11-28') });
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  assert.equal(k.live.play, k.trip);
  await k.to(at('00:00', '2026-11-29'));
  assert.equal(k.live.play, chat);
});

test('dates patched into the open chat make it the trip in play, with no reopening; cleared, play goes back', async () => {
  const k = await liveKit();
  const chat = await k.chat('Ramen');
  await record(k.store, chat, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: at('08:31') });
  k.agent.opened(chat);
  await k.settle();
  assert.equal(k.live.play, k.trip);
  await k.ws.patch(chat, '/trip.json', TODAY, { author: 'shiori' });
  await k.settle();
  assert.equal(k.live.play, chat);
  await k.fix(at('08:40'), MONTEREY);
  assert.equal((await k.events(['location'], chat)).length, 1);
  await k.ws.patch(chat, '/trip.json', { start: null, end: null }, { author: 'shiori' });
  await k.settle();
  assert.equal(k.live.play, k.trip);
});

test('a plan change in the trip in play is followed while another is open; its own, in the open chat, is not', async () => {
  const k = await liveKit({ plan: { bixby: BIX } });
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  await k.ws.write(k.trip, '/plan/nepenthe.json', { id: 'nepenthe', ...NEP }, { author: 'user' });
  await k.settle();
  assert.match(await k.live.listWatches(k.trip), /plan:nepenthe:leave/);
  assert.doesNotMatch(await k.live.listWatches(chat), /plan:/);
});

test('play removed: forget, and nothing more is written there', async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  await k.fix(at('08:40'), MONTEREY);
  const trip = k.trip;
  await removeTrip(k.store, trip);
  await k.live.forget(trip);
  assert.equal(k.live.play, chat);
  await k.fix(at('08:45'), BIXBY);
  await k.to(at('11:09'));
  assert.deepEqual(await k.events(undefined, trip), []);
  assert.deepEqual(said(k), []);
  assert.equal((await k.events(['location'], chat)).length, 1, 'it goes where points go with this one open');
  assert.equal((await k.live.reminders())?.length, 0);
});

test('play archived: tripsChanged moves play on; unarchived, it returns', async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  await setTripStatus(k.store, k.trip, 'archived', at('08:31'));
  await k.live.tripsChanged();
  assert.equal(k.live.play, chat);
  assert.equal((await k.live.reminders())?.length, 0);
  // A write to an archived trip's trip.json doesn't bring it back.
  await k.ws.patch(k.trip, '/trip.json', { places: ['Testville'] }, { author: 'user' });
  await k.settle();
  assert.equal(k.live.play, chat);
  await setTripStatus(k.store, k.trip, 'active', at('08:32'));
  await k.live.tripsChanged();
  assert.equal(k.live.play, k.trip);
  assert.ok((await k.live.reminders())?.some((r) => r.watch === LEAVE));
});

test("a simulation: play is its trip, and the user's happening trip stays quiet; afterwards it is back", async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  const sim = await k.chat('Simulation', { start: '2026-12-10', end: '2026-12-10' });
  await k.ws.patch(sim, '/trip.json', { simulation: true }, { author: 'user' });
  await k.settle();
  const clock = new ManualClock(at('11:00', '2026-12-10'));
  const giveBack = await k.live.simulate({ clock, timeZone: () => LA, trip: sim });
  k.agent.opened(sim);
  await k.settle();
  assert.equal(k.live.play, sim);
  await k.live.setLive(true);
  await k.settle();
  await clock.advanceTo(at('11:30', '2026-12-10'), k.settle);
  assert.deepEqual(await k.events(['trigger.fired']), []);
  assert.deepEqual(said(k), []);
  await giveBack();
  await k.settle();
  assert.equal(k.live.play, k.trip, 'back, with the simulation still open');
  k.agent.opened(k.trip);
  await k.settle();
  await k.to(at('11:09'));
  assert.deepEqual(k.agent.wakes.flatMap((w) => (w.fallbacks ?? []).map((/** @type {any} */ f) => f.watch)), [LEAVE], 'said in the conversation it opened again');
});

test("a simulation's trip outside its run is never chosen", async () => {
  const k = await liveKit({ start: at('08:30', '2026-12-05') });
  const sim = await k.chat('Simulation', { start: '2026-12-05', end: '2026-12-06' });
  await k.ws.patch(sim, '/trip.json', { simulation: true }, { author: 'user' });
  await k.settle();
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  assert.equal(k.live.play, chat, 'dated today, and still not chosen from elsewhere');
  const real = await k.chat('Real', { start: '2026-12-05', end: '2026-12-06' });
  k.agent.opened(sim);
  await k.settle();
  assert.equal(k.live.play, real, 'not even while it is open');
});

test('a restart with a quick chat open: the catch-up reads the trip in play, late reminders once', async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  await k.fix(at('09:00'), MONTEREY);
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  await k.fix(at('09:10'), off(MONTEREY, 0, -500));
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('11:20'));
  await k.restart();
  assert.equal(k.live.play, k.trip);
  await k.fix(at('11:20:05'), off(MONTEREY, 0, -600));
  assert.deepEqual(said(k).filter(([w]) => w === LEAVE), [[LEAVE, k.trip]]);
  assert.equal((await k.events(['trigger.fired'])).filter((e) => e.data.watch === LEAVE).length, 1);
  assert.deepEqual(await k.events(['trigger.fired'], chat), []);
  const wake = k.agent.wakes.find((w) => /time to leave soon/.test(w.text));
  assert.equal(wake.kind, 'catch-up');
  assert.equal(wake.scope, k.trip);
  assert.match(wake.text, /late by \d+ min: annai was closed/);
});

test("a restart's gap counts from the newer of the open conversation's log and the play's, and points pick up from the play's last", async () => {
  const k = await liveKit();
  await k.fix(at('09:00'), MONTEREY);
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  await k.live.setWatch(chat, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea.' });
  await record(k.store, chat, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: at('09:50') });
  await record(k.store, k.trip, { type: 'note', actor: 'system', data: {}, now: at('09:30') });
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('10:30'));
  await k.restart();
  await k.fix(at('10:30:05'), MONTEREY);
  const wake = k.agent.wakes.find((w) => w.kind === 'catch-up');
  assert.match(wake.text, /^Catch-up: annai was closed for 40 min \(since 09:50\)/);
  assert.equal((await k.events(['location'])).length, 1, 'the same place as its last point: no second point');
});

test('a watch written in a conversation that is not open, with #loadAll gone from #follow, is looked at', async () => {
  const k = await liveKit();
  const chat = await k.chat('Ramen');
  await k.live.setWatch(chat, { when: { type: 'time', at: iso('09:00') }, fallback: 'Tea.' });
  // Straight to the file, as a plugin or a restored version would: live mode hears it from the workspace.
  await k.ws.write(chat, '/watches/w-hand.json', { id: 'w-hand', owner: 'shiori', when: { type: 'time', at: iso('09:30') }, repeat: false, fallback: 'By hand.', created: iso('08:30') }, { author: 'user' });
  await k.settle();
  k.agent.opened(chat);
  await k.settle();
  k.agent.opened(k.trip);
  await k.settle();
  await k.to(at('09:30'));
  assert.deepEqual((await k.events(['trigger.fired'], chat)).map((e) => e.data.fallback), ['Tea.', 'By hand.']);
});

test('the plan and the mirrored reminders follow play: reminders() lists its leave-soon, held names the other', async () => {
  const k = await liveKit({ plan: { bixby: BIX, nepenthe: NEP } });
  const chat = await k.chat('Ramen');
  const other = await k.chat('Elsewhere');
  k.agent.opened(chat);
  await k.settle();
  /** @type {Set<string>} */
  let held = new Set();
  const list = await k.live.reminders({ held: (s) => { held = s; } });
  const leave = list?.find((r) => r.watch === LEAVE);
  assert.equal(leave?.scope, k.trip);
  assert.ok(leave?.key.startsWith(`${k.trip}|`));
  assert.deepEqual([...held], [other], 'the open conversation is followed too, so only the other is held');
  assert.match(await k.live.listWatches(k.trip), /plan:nepenthe:leave/);
});


test("a closed annai is told of the open trip's first morning too, while another trip is in play; nothing twice when open is play", async () => {
  const k = await liveKit({ start: at('20:00', '2026-11-28'), plan: { nepenthe: NEP } });
  const next = await k.chat('Next', { start: '2026-11-29', end: '2026-12-01' });
  await k.ws.write(next, '/plan/fly.json', { id: 'fly', title: 'Flight', fixed: true, start: { at: iso('09:00', '2026-11-29'), tz: LA } }, { author: 'user' });
  k.agent.opened(next);
  await k.settle();
  assert.equal(k.live.play, k.trip, 'the trip happening today stays in play');
  /** @type {Set<string>} */
  let held = new Set();
  const list = (await k.live.reminders({ held: (s) => { held = s; } })) ?? [];
  assert.ok(list.some((r) => r.scope === next && r.watch === 'plan:fly:coming-up'), 'the flight reaches the relay');
  assert.ok(!held.has(next), 'followed now, so not held');
  k.agent.opened(k.trip);
  await k.settle();
  const own = (await k.live.reminders()) ?? [];
  assert.equal(new Set(own.map((r) => r.key)).size, own.length, 'no key twice');
  assert.ok(own.every((r) => r.scope !== next), 'the trip no longer open is the relay-held one, not listed');
  assert.ok(own.some((r) => r.scope === k.trip));
});

test("an urgent watch of a trip that isn't open hands its reminders on urgent; a plain one doesn't", async () => {
  const k = await liveKit();
  const chat = await k.chat('Ramen');
  k.agent.opened(chat);
  await k.settle();
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:00') }, fallback: 'Leave now.', urgent: true });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea.' });
  await k.to(at('10:00'));
  assert.deepEqual(k.agent.reminders.map((r) => [r.text, r.scope, r.urgent]), [['Leave now.', k.trip, true], ['Tea.', k.trip, undefined]]);
});
