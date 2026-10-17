import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { meters } from '../../src/core/live/geo.js';

/** Places on the Big Sur drive, and a point some meters away from one. Tests of live mode share these. */
export const MONTEREY = { lat: 36.6036, lng: -121.8916 };
export const BIXBY = { lat: 36.3715, lng: -121.9017 };
export const RIVER_INN = { lat: 36.27, lng: -121.807 };
export const NEPENTHE = { lat: 36.2213, lng: -121.7567 };
export const MCWAY = { lat: 36.158, lng: -121.672 };
export const HEARST = { lat: 35.6852, lng: -121.166 };
export const CAMBRIA = { lat: 35.5641, lng: -121.0807 };
/** Meters in a degree of latitude, as meters() counts them. */
const DEG = (6_371_000 * Math.PI) / 180;
/** A point dx meters east and dy meters north of p. @param {{ lat: number, lng: number }} p @param {number} dx @param {number} dy */
export const off = (p, dx, dy) => ({ lat: p.lat + dy / DEG, lng: p.lng + dx / (DEG * Math.cos((p.lat * Math.PI) / 180)) });
export const LA = 'America/Los_Angeles';
/** A moment on the day of the drive, Pacific time. @param {string} hhmm "09:30" or "09:30:15" */
export const at = (hhmm, day = '2026-11-27') => Date.parse(`${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}-08:00`);
/** The same moment as ISO 8601 with its offset, as plan items and watches write it. @param {string} hhmm */
export const iso = (hhmm, day = '2026-11-27') => `${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}-08:00`;

/** The Agent as live mode sees it: it records wakes and reminders, and can say she woke. @param {string | null} target */
export function fakeAgent(target) {
  /** @type {Set<(e: any) => void>} */
  const listeners = new Set();
  const agent = {
    /** @type {string | null} */
    target,
    /** @type {any[]} */
    wakes: [],
    /** @type {{ watch: string, text: string, scope: string }[]} */
    reminders: [],
    /** @param {any} w */
    wake(w) {
      agent.wakes.push(w);
      return Promise.resolve();
    },
    /** @param {{ watch: string, text: string }[]} list @param {string} [scope] */
    async remind(list, scope) {
      for (const r of list) agent.reminders.push({ ...r, scope: scope ?? agent.target ?? 'me' });
    },
    /** @param {'event'} kind @param {(e: any) => void} fn */
    on(kind, fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    /** She woke, as the Agent logs it. @param {string | null} [scope] */
    woke(scope) {
      for (const fn of listeners) fn({ type: 'wake', scope: scope ?? agent.target, data: {} });
    },
  };
  return agent;
}

/** Sensors a test drives by hand (spec §11.2): location, visibility and connectivity. @param {Registry} registry */
export function fakeSensors(registry) {
  /** @type {Record<string, ((x: any) => void) | null>} */
  const emit = { location: null, visibility: null, connectivity: null };
  for (const kind of Object.keys(emit)) {
    registry.add('test', 'sensor', {
      kind,
      start: (/** @type {(x: any) => void} */ fn) => {
        emit[kind] = fn;
        return () => { if (emit[kind] === fn) emit[kind] = null; };
      },
    });
  }
  return {
    gpsOn: () => emit.location !== null,
    /** @param {any} x */
    fix: (x) => emit.location?.(x),
    /** @param {string} error */
    error: (error) => emit.location?.({ error, message: `GPS ${error}` }),
    /** @param {boolean} v */
    visible: (v) => emit.visibility?.(v),
    /** @param {boolean} v */
    online: (v) => emit.connectivity?.(v),
  };
}

/**
 * A memory annai in live mode: a trip with the plan and bookings given, a Live engine on a manual
 * clock (08:30 on the day of the drive), sensors driven by hand, and an agent that records.
 * @param {{ plan?: Record<string, any>, bookings?: Record<string, any>, live?: boolean, start?: number }} [o]
 */
export async function liveKit({ plan = {}, bookings = {}, live = true, start = at('08:30') } = {}) {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Big Sur', start: '2026-11-27', end: '2026-11-28' });
  for (const [name, item] of Object.entries(plan)) await ws.write(trip, `/plan/${name}.json`, { id: name, ...item }, { author: 'user' });
  for (const [name, b] of Object.entries(bookings)) await ws.write(trip, `/bookings/${name}.json`, b, { author: 'user' });
  if (live) await updateAppSettings(ws, { live: { on: true } });
  const clock = new ManualClock(start);
  const agent = fakeAgent(trip);
  const sensors = fakeSensors(registry);
  const engine = new Live({ store, ws, registry, agent, clock, timeZone: () => LA });
  await engine.start();
  await engine.settled();
  const settle = () => engine.settled();
  const k = {
    registry, store, ws, trip, clock, agent, sensors, live: engine, settle,
    /** Moves the clock to t, firing the timers that come due on the way. @param {number} t */
    to: (t) => clock.advanceTo(t, settle),
    /** A GPS fix at p, at t. @param {number} t @param {{ lat: number, lng: number }} p @param {Record<string, any>} [o] */
    async fix(t, p, o = {}) {
      await clock.advanceTo(t, settle);
      sensors.fix({ lat: p.lat, lng: p.lng, accuracy: 8, speed: 0, ...o });
      await settle();
    },
    /** Driving from a to b between t0 and t1, a fix every so many seconds. @param {{ lat: number, lng: number }} a @param {{ lat: number, lng: number }} b @param {number} t0 @param {number} t1 */
    async drive(a, b, t0, t1, every = 5) {
      const speed = meters(a, b) / ((t1 - t0) / 1000);
      for (let t = t0; t <= t1; t += every * 1000) {
        const f = (t - t0) / (t1 - t0);
        await k.fix(t, { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f }, { speed });
      }
    },
    /** Staying at p from t0 to t1, a fix every so many seconds. @param {{ lat: number, lng: number }} p @param {number} t0 @param {number} t1 */
    async stay(p, t0, t1, every = 10) {
      for (let t = t0; t <= t1; t += every * 1000) await k.fix(t, p, { speed: 0 });
    },
    /** @param {string[]} [types] @param {string} [scope] */
    events: (types, scope = trip) => store.tx(['events'], 'readonly', (t) => t.listEvents(scope, types ? { types } : {})),
  };
  return k;
}
