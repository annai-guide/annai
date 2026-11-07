import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { fakeSensors, at, iso, off, LA, BIXBY } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { createTrip, listTrips } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';

// "Talking moves it" (the user, 2026-11-06): looking at a trip never changes the trip in play; only talking in another happening trip does.
// The real Agent and Live, so a line reaches live mode by the road it takes in the app.

const TODAY = { start: '2026-11-27', end: '2026-11-28' };
const sleeps = { rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] };
/** A fixed plan item at hhmm, with no place: it says "coming up" 15 minutes before. @param {string} id @param {string} hhmm */
const item = (id, hhmm) => ({ id, title: id, fixed: true, start: { at: iso(hhmm), tz: LA } });

/**
 * Two trips happening today, each with a plan, and live mode on a manual clock. road is in play: the user talked there last, and it's open.
 * @param {Parameters<typeof agentKit>[1]} [o]
 */
async function twoTrips(o = {}) {
  const clock = new ManualClock(at('08:30'));
  const k = await agentKit([sleeps], { ...o, agent: { now: clock.now, timeZone: () => LA } });
  const road = await createTrip(k.ws, { title: 'Road', ...TODAY });
  const side = await createTrip(k.ws, { title: 'Side', ...TODAY });
  await k.ws.write(road, '/plan/lunch.json', item('lunch', '12:00'), { author: 'user' });
  await k.ws.write(side, '/plan/tea.json', item('tea', '11:00'), { author: 'user' });
  await updateAppSettings(k.ws, { live: { on: true } });
  const sensors = fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA });
  await k.agent.open(road);
  await live.start();
  const settle = async () => {
    let before;
    do {
      before = k.requests.length;
      await live.settled();
      await k.agent.idle();
      await live.settled();
    } while (k.requests.length !== before);
  };
  k.agent.send('Good morning');
  await settle();
  assert.equal(live.play, road);
  /** The trip in play's and the open one's plan reminders, and the trips whose copies are held to what their plan says, every trip having some. */
  const mirrored = async () => {
    /** @type {Map<string, string>} */
    let says = new Map();
    const list = (await live.reminders({ waiting: new Set((await listTrips(k.store)).active.map((t) => t.id)), held: (s) => { says = s; } })) ?? [];
    return { plans: new Set(list.filter((r) => r.watch.startsWith('plan:')).map((r) => r.scope)), held: new Set([...says.keys()].map((key) => key.split('|')[0])), keys: list.map((r) => r.key) };
  };
  const fired = async (/** @type {string} */ scope) => (await k.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['trigger.fired'] }))).map((e) => e.data.watch);
  const to = (/** @type {number} */ t) => clock.advanceTo(t, settle);
  /** A line typed a minute on: two lines never share a moment, and a tie would go by id. @param {string} text */
  const type = async (text) => {
    await to(clock.now() + 60_000);
    k.agent.send(text);
    await settle();
  };
  /** The same, heard. @param {any} heard the entry's data @param {any} [agent] */
  const hear = async (heard, agent = k.agent) => {
    await to(clock.now() + 60_000);
    await agent.log({ type: 'heard', actor: 'user', data: { ms: 900, source: 'live', ...heard } });
    await settle();
  };
  return { ...k, clock, sensors, live, road, side, settle, mirrored, fired, to, type, hear };
}

test('opening an overlapping trip leaves play and its reminders alone: the road goes on, and the one looked at reminds of nothing', async () => {
  const k = await twoTrips();
  await k.live.setWatch(k.side, { when: { type: 'enter', lat: BIXBY.lat, lng: BIXBY.lng, radius: 300 }, fallback: 'At the bridge.' });
  await k.agent.open(k.side);
  await k.settle();
  assert.equal(k.live.play, k.road, 'looking moves nothing');
  const m = await k.mirrored();
  assert.deepEqual([...m.plans], [k.road], 'what waits at the relay is the trip in play\'s');
  assert.ok(m.held.has(k.side), 'copies of the open one already at the relay stay there, while its plan says the same');
  await k.to(at('10:45')); // tea's coming-up
  assert.deepEqual(await k.fired(k.side), [], 'its plan waits');
  k.sensors.fix({ lat: off(BIXBY, 0, 2000).lat, lng: off(BIXBY, 0, 2000).lng, accuracy: 8, speed: 0 });
  await k.settle();
  await k.to(at('10:50'));
  k.sensors.fix({ lat: BIXBY.lat, lng: BIXBY.lng, accuracy: 8, speed: 0 });
  await k.settle();
  assert.deepEqual(await k.fired(k.side), [], 'a location reminder waits too, as "Only the trip in play reminds" says');
  await k.to(at('11:45')); // lunch's coming-up, with Side open
  assert.ok((await k.fired(k.road)).includes('plan:lunch:coming-up'), 'the trip in play reminds, wherever you are looking');
});

test('a line typed in another happening trip moves play at once, and the plan and the relay move with it', async () => {
  const k = await twoTrips();
  await k.agent.open(k.side);
  await k.settle();
  await k.type('Is the tea still on?');
  assert.equal(k.live.play, k.side, 'no fix needed');
  const m = await k.mirrored();
  assert.deepEqual([...m.plans], [k.side]);
  assert.ok(m.held.has(k.road));
  await k.to(at('10:45'));
  assert.deepEqual(await k.fired(k.side), ['plan:tea:coming-up']);
});

test('moved by a line, the listeners hear it: Driving and the Itinerary link learn of it the same moment', async () => {
  const k = await twoTrips();
  await k.agent.open(k.side);
  await k.settle();
  /** @type {(string | null)[]} */
  const heard = [];
  await k.to(at('08:40'));
  k.live.onReminders(() => { heard.push(k.live.play); });
  k.agent.send('Is the tea still on?');
  await k.settle();
  assert.ok(heard.includes(k.side));
});

test('a line that moves play tells the relay to sync soon ("prompt"), not only at the calm pace', async () => {
  const k = await twoTrips();
  await k.agent.open(k.side);
  await k.settle();
  await k.to(at('08:40'));
  /** @type {string[]} */
  const levels = [];
  k.live.onReminders((level) => { levels.push(level); });
  k.agent.send('Is the tea still on?');
  await k.settle();
  assert.ok(levels.includes('prompt'), levels.join());
});

test('with two halves, a line typed or heard moves play too', async () => {
  const k = await twoTrips({ koe: { type: sleeps } });
  await k.agent.split();
  await k.agent.open(k.side);
  await k.settle();
  assert.equal(k.live.play, k.road);
  await k.type('Is the tea still on?');
  assert.equal(k.live.play, k.side, 'typed');
  await k.agent.open(k.road);
  await k.settle();
  assert.equal(k.live.play, k.side);
  await k.hear({ id: 'h1', text: 'Back to the road' }, k.agent.koe);
  assert.equal(k.live.play, k.road, 'heard');
});

test("a dismissed line doesn't move play; one heard and kept does", async () => {
  const k = await twoTrips();
  await k.agent.open(k.side);
  await k.settle();
  await k.hear({ id: 'h1', text: 'two coffees please', dismissed: true, gate: 'chatter' });
  assert.equal(k.live.play, k.road, 'someone else, or not to Shiori');
  await k.hear({ id: 'h2', text: 'Is the tea still on?' });
  assert.equal(k.live.play, k.side);
});

test('a line in a chat with no dates moves nothing', async () => {
  const k = await twoTrips();
  const chat = await createTrip(k.ws, { title: 'Ramen' });
  await k.agent.open(chat);
  await k.settle();
  await k.type('Where was that ramen place?');
  assert.equal(k.live.play, k.road);
});

test('a line in the trip in play changes nothing, and is still counted when another trip starts', async () => {
  const k = await twoTrips();
  const tomorrow = await createTrip(k.ws, { title: 'Tomorrow', start: '2026-11-28', end: '2026-11-28' });
  await k.agent.open(tomorrow);
  await k.settle();
  await k.type('What about tomorrow?');
  assert.equal(k.live.play, k.road, "it isn't happening yet");
  await k.agent.open(k.road);
  await k.settle();
  await k.type('And this morning?');
  await k.to(at('00:01', '2026-11-28'));
  assert.equal(k.live.play, k.road, 'at midnight the last line said in a happening trip still counts');
});

test('nothing fires twice on the move, there and back', async () => {
  const k = await twoTrips();
  await k.to(at('10:45'));
  await k.type('Tell me about lunch');
  await k.agent.open(k.side);
  await k.type('Is the tea still on?');
  assert.equal(k.live.play, k.side);
  await k.to(at('10:50'));
  assert.deepEqual(await k.fired(k.side), ['plan:tea:coming-up'], 'still ahead when play came: it comes, once');
  await k.agent.open(k.road);
  await k.type('Back to the road');
  assert.equal(k.live.play, k.road);
  await k.to(at('11:50'));
  await k.agent.open(k.side);
  await k.type('And the tea?');
  await k.agent.open(k.road);
  await k.type('And lunch?');
  await k.to(at('11:55'));
  assert.deepEqual(await k.fired(k.side), ['plan:tea:coming-up']);
  assert.deepEqual((await k.fired(k.road)).filter((w) => w === 'plan:lunch:coming-up'), ['plan:lunch:coming-up']);
  const { keys } = await k.mirrored();
  assert.equal(new Set(keys).size, keys.length);
});

test("a quick chat's own location reminder still fires while it's open, and an open trip not yet happening still reaches the relay", async () => {
  const k = await twoTrips();
  const chat = await createTrip(k.ws, { title: 'Ramen' });
  await k.agent.open(chat);
  await k.settle();
  await k.live.setWatch(chat, { when: { type: 'enter', lat: BIXBY.lat, lng: BIXBY.lng, radius: 300 }, fallback: 'At the bridge.' });
  const far = off(BIXBY, 0, 2000);
  k.sensors.fix({ ...far, accuracy: 8, speed: 0 });
  await k.settle();
  await k.to(at('08:45'));
  k.sensors.fix({ ...BIXBY, accuracy: 8, speed: 0 });
  await k.settle();
  await until(() => k.agent.busy === false);
  assert.equal((await k.fired(chat)).length, 1);
  const next = await createTrip(k.ws, { title: 'Next', start: '2026-11-29', end: '2026-11-30' });
  await k.ws.write(next, '/plan/fly.json', { id: 'fly', title: 'Flight', fixed: true, start: { at: iso('09:00', '2026-11-29'), tz: LA } }, { author: 'user' });
  await k.agent.open(next);
  await k.settle();
  const m = await k.mirrored();
  assert.deepEqual([...m.plans].sort(), [k.road, next].sort());
  assert.ok(!m.held.has(next));
});

test("a line kept for another conversation moves play at once, not at the next look or reload", async () => {
  const k = await twoTrips();
  await k.to(at('08:40'));
  // The route of a line with files, sent while another conversation opens: it is written into the trip it was typed in.
  await k.agent.wake({ kind: 'user', text: 'Is the tea still on?', scope: k.side });
  await k.settle();
  assert.equal(k.live.play, k.side);
});

test("a hand-over's copy in a happening trip isn't talking: a look there leaves play on the road, and so does a reload", async () => {
  const k = await twoTrips();
  await k.to(at('08:40'));
  await k.agent.wake({ kind: 'user', text: 'Here is the booking', handover: 'h1', fromScope: k.road, scope: k.side });
  await k.settle();
  const rec = await k.store.tx(['scopes'], 'readonly', (t) => t.getScope(k.side));
  assert.equal(rec.talked, null, 'stamped nothing');
  await k.agent.open(k.side);
  await k.settle();
  assert.equal(k.live.play, k.road, 'a look');
  await k.agent.open(k.road);
  await k.settle();
  assert.equal(k.live.play, k.road);
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA });
  await again.start();
  assert.equal(again.play, k.road, 'a reload');
  again.dispose();
  await k.agent.open(k.side);
  await k.type('Is the tea still on?');
  assert.equal(k.live.play, k.side, 'the next line of theirs there moves it');
});

test("midnight passes while the phone sleeps: Side, open and starting today, reaches the relay at the first look, with no timer having run", async () => {
  const clock = new ManualClock(at('23:30'));
  let jump = 0;
  const real = clock.now;
  clock.now = () => jump || real();
  const k = await agentKit([sleeps], { agent: { now: () => clock.now(), timeZone: () => LA } });
  const road = await createTrip(k.ws, { title: 'Road', start: '2026-11-27', end: '2026-11-27' });
  const side = await createTrip(k.ws, { title: 'Side', start: '2026-11-28', end: '2026-11-28' });
  await k.ws.write(road, '/plan/lunch.json', item('lunch', '12:00'), { author: 'user' });
  await k.ws.write(side, '/plan/tea.json', { id: 'tea', title: 'tea', fixed: true, start: { at: iso('07:00', '2026-11-28'), tz: LA } }, { author: 'user' });
  await updateAppSettings(k.ws, { live: { on: true } });
  fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA });
  await k.agent.open(side);
  await live.start();
  await live.settled();
  const plans = async () => ((await live.reminders()) ?? []).filter((m) => m.watch.startsWith('plan:')).map((m) => `${m.scope === road ? 'road' : 'side'}:${m.watch}`);
  assert.deepEqual((await plans()).sort(), ['road:plan:lunch:coming-up', 'side:plan:tea:coming-up'], 'Road is in play; Side, opened and not yet happening, still reaches the relay');
  jump = at('00:10', '2026-11-28'); // the sleeping phone wakes in the new day; no timer ran in between
  assert.deepEqual(await plans(), ['side:plan:tea:coming-up'], 'Road is over, and Side is in play');
  live.dispose();
});
