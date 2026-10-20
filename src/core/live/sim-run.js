import { trackFrom, trackFromLog, Simulation } from './simulate.js';
import { ManualClock, PlayClock, realClock } from './clock.js';
import { createTrip, removeTrip } from '../scopes.js';
import { readAppSettings, updateAppSettings } from '../settings.js';
import { validZone, deviceZone, dayIn } from '../time.js';
import { pointsOf } from '../after/route.js';
import { PLAN_FILE, BOOKING_FILE } from '../plan.js';

/**
 * Developer → "Simulate a trip" (spec §13): a recorded or made-up GPS track and its clock fed through
 * live mode and Shiori as on the road, in a new trip of its own (choice 9), so the replay and the recap
 * can be tried before a real trip. The screen and the tests share it.
 * @typedef {import('./simulate.js').Itinerary & { timezone?: string, plan?: Record<string, any>, bookings?: Record<string, any> }} SimItinerary
 * @typedef {{ kind: 'itinerary', itinerary: SimItinerary } | { kind: 'trip', trip: string }} SimSource
 * @typedef {'fast' | number} SimSpeed  fast: as fast as it can go; a number: that many times real time
 * @typedef {{ trip: string, title: string, tz: string, from: number, to: number, speed: SimSpeed, paused: boolean, done: boolean, stopped: boolean, error: string | null }} SimState
 *   tz: the trip's zone, for its times
 * @typedef {{ track: import('./simulate.js').TrackEvent[], tz: string, title: string, make: () => Promise<string> }} Prepared
 */

/** The speeds a simulation can play at, besides as fast as it can go (choice 13). */
export const SPEEDS = Object.freeze([10, 60, 600]);

/**
 * At a start: a simulation that was running when the page went away (a reload, or iOS letting it go in
 * the background) is over. The trip open before it opens again, if it is still here, so live mode
 * goes on into the user's own trip (review 3). Returns that trip, or null when nothing was running.
 * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace }} c @returns {Promise<string | null>}
 */
export async function recoverSimulation({ store, ws }) {
  const s = (await readAppSettings(ws)).simulation;
  if (!s || typeof s !== 'object') return null;
  const before = typeof s.before === 'string' && (await store.tx(['scopes'], 'readonly', (t) => t.getScope(s.before))) ? s.before : null;
  await updateAppSettings(ws, { activeTrip: before, simulation: null });
  return before;
}

/** A file name from an itinerary's key. @param {string} name */
const fileName = (name) => String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';

export class SimRun {
  /** @type {SimState | null} the running simulation, or the last one */
  state = null;
  /** Settles when the running simulation has ended. @type {Promise<void>} */
  finished = Promise.resolve();
  /** @type {import('./clock.js').Clock | null} */
  #clock = null;
  /** @type {Set<() => void>} */
  #listeners = new Set();
  /** @type {AbortController | null} */
  #abort = null;
  /** @type {Promise<void> | null} while paused (as fast as it can go) */
  #held = null;
  /** @type {(() => void) | null} */
  #release = null;

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry,
   *   agent: import('../agent/loop.js').Agent | import('../agent/halves.js').Halves, live: import('./live.js').Live, base?: import('./clock.js').Clock,
   *   llm?: { forgetScope: (scope: string) => Promise<unknown> } }} c llm: what a provider kept of a trip removed here goes too (G2)
   *   base: the clock a timed simulation plays on (the real one; tests pass a manual one)
   */
  constructor(c) {
    this.c = c;
  }

  get running() {
    return Boolean(this.state && !this.state.done);
  }

  /** The simulated time now, while one runs. */
  now() {
    return this.#clock ? this.#clock.now() : null;
  }

  /** @param {() => void} fn @returns {() => void} */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /**
   * Starts a simulation in a new trip and settles once it runs (Shiori has heard live mode come on);
   * `finished` settles when it ends. A broken source is a plain error, and then no trip is made.
   * @param {SimSource} source @param {{ speed?: SimSpeed }} [o] @returns {Promise<{ trip: string }>}
   */
  async start(source, { speed = 10 } = {}) {
    if (this.running) throw new Error('A simulation is already running. Stop it first.');
    const { agent, live, registry, ws, store } = this.c;
    const p = source.kind === 'trip' ? await this.#fromTrip(source.trip) : this.#fromItinerary(source.itinerary);
    const trip = await p.make();
    const before = agent.target;
    // Remembered until it ends, so a reload in the middle (iOS lets a page go in the background) opens the trip before again (review 3).
    await updateAppSettings(ws, { activeTrip: trip, simulation: { trip, before } });
    const clock = speed === 'fast' ? new ManualClock(p.track[0].at) : new PlayClock(p.track[0].at, { speed, base: this.c.base ?? realClock() });
    this.#clock = clock;
    // Live mode is on the simulation's clock before its trip opens, so the trip is never looked at on the real clock.
    const giveBack = await live.simulate({ clock, timeZone: () => p.tz, trip });
    try {
      await agent.open(trip);
    } catch (e) {
      await giveBack();
      this.#clock = null;
      throw e;
    }
    const sim = new Simulation({ registry, track: p.track });
    const restore = agent.useClock({ now: clock.now, online: () => sim.online, timeZone: () => p.tz, scope: trip });
    this.state = { trip, title: p.title, tz: p.tz, from: p.track[0].at, to: p.track[p.track.length - 1].at, speed, paused: false, done: false, stopped: false, error: null };
    this.#abort = new AbortController();
    this.#emit();
    const state = this.state;
    // Another trip opened: the simulation stops, and that trip stays open (choice 10).
    const offOpen = agent.on('open', (/** @type {{ trip: string | null }} */ o) => { if (o.trip !== trip) this.stop(); });
    /** @type {() => void} */
    let begun = () => {};
    const playing = new Promise((resolve) => { begun = () => resolve(undefined); });
    this.finished = (async () => {
      try {
        await live.setLive(true); // Shiori hears it, as when the user turns live mode on
        await this.#settle();
        begun();
        if (clock instanceof ManualClock) {
          await sim.run(clock, () => this.#settle(), { signal: this.#abort?.signal, gate: () => this.#held ?? Promise.resolve() });
        } else {
          await new Promise((resolve) => {
            const signal = this.#abort?.signal;
            if (signal?.aborted) {
              resolve(undefined); // stopped before it began to play
              return;
            }
            const stop = sim.play(clock, { onEnd: () => resolve(undefined) });
            signal?.addEventListener('abort', () => { stop(); resolve(undefined); }, { once: true });
          });
        }
        await this.#settle();
        // The track's end is where live mode goes off, so its last stay has an end (7a Task 5 ruling); never in another trip.
        if (agent.target === trip) {
          await live.setLive(false);
          await this.#settle();
        }
      } catch (e) {
        state.error = String(/** @type {any} */ (e)?.message ?? e);
      } finally {
        offOpen();
        sim.dispose();
        await giveBack();
        restore();
        // The trip open before opens again, so the phone's own GPS goes on into it (choice 9), unless the user opened another.
        if (agent.target === trip) {
          const back = before && before !== trip && (await store.tx(['scopes'], 'readonly', (t) => t.getScope(before))) ? before : null;
          await updateAppSettings(ws, { activeTrip: back, simulation: null }).catch(() => {});
          await agent.open(back).catch(() => {});
        } else {
          await updateAppSettings(ws, { simulation: null }).catch(() => {});
        }
        this.#clock = null;
        this.#held = null;
        this.#release?.();
        state.done = true;
        state.paused = false;
        begun();
        this.#emit();
      }
    })();
    await playing;
    return { trip };
  }

  /** Pauses it. */
  pause() {
    const s = this.state;
    if (!s || s.done || s.paused) return;
    s.paused = true;
    if (this.#clock instanceof PlayClock) this.#clock.pause();
    else this.#held = new Promise((resolve) => { this.#release = () => resolve(undefined); });
    this.#emit();
  }

  /** Goes on after a pause. */
  resume() {
    const s = this.state;
    if (!s || s.done || !s.paused) return;
    s.paused = false;
    if (this.#clock instanceof PlayClock) this.#clock.play();
    this.#held = null;
    this.#release?.();
    this.#release = null;
    this.#emit();
  }

  /** A new speed, while it plays in time (as fast as it can go has none). @param {number} speed */
  setSpeed(speed) {
    const s = this.state;
    if (!s || s.done || !(this.#clock instanceof PlayClock) || !(speed > 0)) return;
    this.#clock.speed = speed;
    s.speed = speed;
    this.#emit();
  }

  /** Stops it; what it did stays in its trip. */
  stop() {
    const s = this.state;
    if (!s || s.done) return;
    s.stopped = true;
    this.#abort?.abort();
    this.resume();
  }

  #emit() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a simulation listener failed', e);
      }
    }
  }

  /** Live mode and Shiori have done what this moment asked of them. */
  async #settle() {
    const { live, agent } = this.c;
    for (let i = 0; i < 20; i++) {
      await live.settled();
      await agent.idle();
      await live.settled();
      if (!agent.busy) return;
    }
  }

  /** @param {SimItinerary} it @returns {Prepared} */
  #fromItinerary(it) {
    const track = trackFrom(it);
    const tz = validZone(it?.timezone) ? /** @type {string} */ (it.timezone) : deviceZone();
    const title = `${String(it?.name ?? '').trim().slice(0, 150) || 'A simulated trip'} (simulation)`;
    const { ws, store } = this.c;
    return {
      track, tz, title,
      make: async () => {
        const id = await createTrip(ws, { title, start: /** @type {string} */ (dayIn(track[0].at, tz)), end: /** @type {string} */ (dayIn(track[track.length - 1].at, tz)) });
        /** @type {[string, string, any][]} */
        const files = [
          ...Object.entries(it.plan ?? {}).map(([n, v]) => /** @type {[string, string, any]} */ ([`plan item "${n}"`, `/plan/${fileName(n)}.json`, v])),
          ...Object.entries(it.bookings ?? {}).map(([n, v]) => /** @type {[string, string, any]} */ ([`booking "${n}"`, `/bookings/${fileName(n)}.json`, v])),
        ];
        try {
          // Marked a simulation's: outside its run, live mode leaves it as it is (review 4).
          await ws.patch(id, '/trip.json', { timezones: [tz], simulation: true }, { author: 'user' });
          for (const [what, path, value] of files) {
            try {
              await ws.write(id, path, value, { author: 'user' });
            } catch (e) {
              const why = /** @type {any} */ (e)?.errors?.join('; ') ?? String(/** @type {any} */ (e)?.message ?? e);
              throw new Error(`The itinerary's ${what} doesn't fit annai's ${path.startsWith('/plan/') ? 'plan' : 'booking'} format: ${why}. Fix it in the file and try again.`);
            }
          }
        } catch (e) {
          await removeTrip(store, id).catch(() => {});
          await this.c.llm?.forgetScope(id).catch(() => {});
          throw e;
        }
        return id;
      },
    };
  }

  /** A trip's recorded track, its plan and bookings (choice 12). @param {string} id @returns {Promise<Prepared>} */
  async #fromTrip(id) {
    const { store, ws } = this.c;
    const scope = await store.tx(['scopes'], 'readonly', (t) => t.getScope(id));
    if (!scope || scope.kind !== 'trip') throw new Error("That trip isn't on this device any more.");
    const events = await store.tx(['events'], 'readonly', (t) => t.listEvents(id, { types: ['location', 'state'] }));
    const points = pointsOf(events.filter((e) => e.type === 'location'));
    const lastAt = points.length ? points[points.length - 1].at : Infinity;
    // Live mode turned off after the last point: the last stop lasted until then (as the journey reads it).
    const end = events.find((e) => e.type === 'state' && e.data?.live === 'off' && e.ts > lastAt)?.ts;
    const track = trackFromLog(points, end === undefined ? {} : { end });
    const info = (await ws.readJSON(id, '/trip.json').catch(() => null)) ?? {};
    const tz = [info.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
    const title = `${scope.title.slice(0, 150)} (simulation)`;
    /** @type {[string, any][]} */
    const copies = [];
    for (const f of await ws.list(id, '/')) {
      if (!PLAN_FILE.test(f.path) && !BOOKING_FILE.test(f.path)) continue;
      const v = await ws.readJSON(id, f.path).catch(() => null);
      if (v && typeof v === 'object') copies.push([f.path, v]);
    }
    return {
      track, tz, title,
      make: async () => {
        const t = await createTrip(ws, { title, start: /** @type {string} */ (dayIn(track[0].at, tz)), end: /** @type {string} */ (dayIn(track[track.length - 1].at, tz)) });
        await ws.patch(t, '/trip.json', { timezones: [tz], simulation: true, ...(Array.isArray(info.party) ? { party: info.party } : {}), ...(Array.isArray(info.places) ? { places: info.places } : {}) }, { author: 'user' });
        for (const [path, v] of copies) await ws.write(t, path, v, { author: 'user' }).catch(() => {}); // one annai no longer accepts stays out
        return t;
      },
    };
  }
}
