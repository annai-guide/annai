import { readFile } from 'node:fs/promises';
import { agentKit } from './agent-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { trackFrom, Simulation } from '../../src/core/live/simulate.js';
import { watchTools } from '../../src/core/live/watch-tools.js';

/** The Big Sur sample (spec §18), as the Simulate a trip screen ships it. */
export const DRIVE = JSON.parse(await readFile(new URL('../../assets/simulations/big-sur.json', import.meta.url), 'utf8'));
const sleep = { name: 'sleep', input: {} };
const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
export const NARRATE = 'Highway 1 runs on south along the coast.';
/**
 * Shiori, scripted (spec §18): what the driving-companion and replanning skills tell her to do,
 * for each thing that can wake her. The first rule whose match finds what woke her answers.
 */
export const RULES = [
  { match: 'turned GPS on', reply: { toolCalls: [{ name: 'watch_set', input: { when: { type: 'activity', activity: 'moving-fast' }, repeat: true, fallback: 'On the road again. The plan has the next stop.' } }, sleep] } },
  { match: '^Catch-up', reply: { toolCalls: [speak('Welcome back. We have covered some ground.'), sleep] } },
  { match: '^While there was no connection', reply: { toolCalls: [sleep] } },
  { match: 'is now moving fast', times: 1, reply: { toolCalls: [{ name: 'watch_set', input: { when: { type: 'moved', km: 15 }, repeat: true, fallback: NARRATE } }, speak('Off we go. Bixby Bridge comes first.'), sleep] } },
  { match: 'is now moving fast', reply: { toolCalls: [sleep] } },
  { match: 'travelled .* km since your last wake', reply: { toolCalls: [{ name: 'nearby', input: { lat: 36.307, lng: -121.899, radius: 8000, kinds: ['sights'] } }, speak('Point Sur Lighthouse is up on the rock to the right.'), sleep] } },
  { match: 'you arrived at', reply: { toolCalls: [speak('Here we are.'), sleep] } },
  {
    match: '^Off plan: the user has been stopped', times: 1,
    reply: {
      toolCalls: [
        { name: 'patch', input: { path: '/trip/plan/mcway.json', changes: { start: { at: '2026-11-27T14:00:00-08:00', tz: 'America/Los_Angeles' }, end: { at: '2026-11-27T14:30:00-08:00', tz: 'America/Los_Angeles' } } } },
        speak('Take your time here. I moved McWay Falls to two; lunch at Nepenthe stays at noon.'), sleep,
      ],
    },
  },
  { match: '^Off plan', reply: { toolCalls: [speak('No rush. The castle tour is at half past four.'), sleep] } },
  { match: 'time to leave soon', reply: { toolCalls: [speak('Time to head on soon.'), sleep] } },
  { match: 'running late', reply: { toolCalls: [speak('We will be a few minutes late for the castle tour.'), sleep] } },
];
/** The wakes the drive must produce, in order: what fired, in a few words. */
export const EXPECTED = [
  'live mode on', 'driving', 'moved', 'arrived: Bixby Creek Bridge',
  'driving', 'moved', 'stopped off plan', 'leave: Lunch at Nepenthe',
  'driving', 'arrived: Nepenthe',
  'driving', 'arrived: McWay Falls',
  'driving', 'back online', 'stopped off plan',
  'driving', 'catch-up', 'stopped off plan', 'late: Hearst Castle tour',
  'driving', 'arrived: Hearst Castle',
  'driving', 'moved', 'arrived: Cambria Pines Lodge',
];

/** A wake's reasons in a few words. @param {any[]} reasons */
export function label(reasons) {
  const r = reasons.find((x) => x.kind !== 'user') ?? reasons[0];
  const t = String(r.text ?? '');
  if (r.kind === 'live') return 'live mode on';
  if (r.kind === 'catch-up') return 'catch-up';
  if (t.startsWith('While there was no connection')) return 'back online';
  if (t.includes('is now moving fast')) return 'driving';
  if (/travelled .* km since your last wake/.test(t)) return 'moved';
  const arrived = /you arrived at (.+?) for "/.exec(t);
  if (arrived) return `arrived: ${arrived[1]}`;
  if (t.startsWith('Off plan: the user has been stopped')) return 'stopped off plan';
  const leave = /time to leave soon for "(.+?)"/.exec(t);
  if (leave) return `leave: ${leave[1]}`;
  const late = /running late for "(.+?)"/.exec(t);
  if (late) return `late: ${late[1]}`;
  return t;
}

/** Overpass and Wikipedia, answering as they would near Point Sur. @param {string} url */
export async function places(url) {
  const body = String(url).includes('overpass')
    ? { elements: [{ type: 'node', lat: 36.3066, lon: -121.9017, tags: { name: 'Point Sur Light Station', tourism: 'attraction' } }] }
    : { query: { geosearch: [] } };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * The Big Sur drive (spec §18) on a memory annai: the plan and bookings written, live mode turned on in
 * Monterey, the whole track run through the sensors on a manual clock, each step settled, and live mode
 * turned off at the end in Cambria.
 * @param {{ utility?: any[] }} [o] utility: a script for a utility model (the recap's)
 */
export async function driveBigSur({ utility } = {}) {
  const track = trackFrom(DRIVE);
  const clock = new ManualClock(track[0].at);
  /** @type {Simulation | null} */
  let sim = null;
  const k = await agentKit([{ rules: RULES }], {
    agent: { now: clock.now, timeZone: () => DRIVE.timezone, online: () => sim?.online ?? true, fetch: places },
    voice: { mode: 'auto' }, ...(utility ? { utility } : {}),
  });
  await k.host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  await k.ws.patch(k.trip, '/trip.json', { timezones: [DRIVE.timezone] }, { author: 'user' });
  for (const [name, item] of Object.entries(DRIVE.plan)) await k.ws.write(k.trip, `/plan/${name}.json`, item, { author: 'user' });
  for (const [name, b] of Object.entries(DRIVE.bookings)) await k.ws.write(k.trip, `/bookings/${name}.json`, b, { author: 'user' });
  sim = new Simulation({ registry: k.registry, track });
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => DRIVE.timezone });
  k.agent.addLoopTools(watchTools(live));
  k.agent.sense = () => live.nowInfo();
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
  await settle();
  await live.setLive(true); // the user turns live mode on in Monterey
  await settle();
  await sim.run(clock, settle);
  await live.setLive(false); // and off in Cambria, at the end of the day
  await settle();
  return { k, live, track };
}
