import { meters, keep, fixOf, kmText, span, KEEP_M } from './geo.js';
import { ActivityTracker, STILL_BELOW } from './activity.js';
import { TRIGGERS } from './triggers.js';
import { PLAN, planWatches } from './plan-watches.js';
import { readWatches, saveWatch, removeWatch, newWatchId, expired, watchPath, WATCH_FILE } from './watches.js';
import { DRIVING, REPLANNING } from './skills.js';
import { realClock } from './clock.js';
import { readAppSettings, updateAppSettings } from '../settings.js';
import { logEvent } from '../events.js';
import { ME, listTrips } from '../scopes.js';
import { PLAN_FILE, BOOKING_FILE } from '../plan.js';
import { validZone, deviceZone, isoInZone, timeIn } from '../time.js';
import { validate } from '../schema.js';
import { tsv } from '../tsv.js';

/**
 * Live mode (spec §11): where the user is and what they are doing, the watches and the plan's own
 * reminders, and reminders that work without a model (§11.3, §17). The core never touches the DOM
 * (§3): sensors are registry items of kind "sensor", so the phone's sensors and a simulation
 * (§13, §18) are interchangeable.
 * @typedef {import('./geo.js').Fix} Fix
 * @typedef {import('./triggers.js').TriggerType & { pluginId?: string }} TriggerType
 * @typedef {import('./triggers.js').Moment} Moment
 * @typedef {import('./triggers.js').Firing} Firing
 * @typedef {import('./watches.js').Watch} Watch
 * @typedef {{ scope: string, watch: Watch, type: TriggerType, firing: Firing, late: number, away?: 'start' | 'shown', fallback: string }} Fired
 *   late: minutes after it came due, in a catch-up; away: how annai was away then
 * @typedef {{ watch: string, text: string }} Reminder
 * @typedef {{ target: string | null, wake: (w: any) => Promise<void>, remind: (list: Reminder[], scope?: string) => Promise<void>,
 *   on: (kind: 'event' | 'open', fn: (e: any) => void) => () => void }} AgentLike  the Agent, as live mode uses it
 * @typedef {{ kind: 'location' | 'visibility' | 'connectivity', start: (emit: (x: any) => void) => (() => void) | void }} Sensor
 *   location emits { lat, lng, accuracy, speed?, heading? }, or { error: 'denied' | 'unavailable', message };
 *   visibility emits true or false; connectivity true (online) or false
 */

/** A stop: staying within this many meters of where it began. */
export const STOP_M = 100;
/** A position this old no longer says where the user is. */
export const FRESH_MS = 10 * 60_000;
/** While live, the clock looks again at least this often (arrival estimates change with time). */
export const RECHECK_MS = 60_000;
/** The one timer waits at most a day, whatever is planned weeks ahead: the clock can't hold much longer. */
export const MAX_WAIT_MS = 86_400_000;
/** After coming back on screen, catch-up waits this long for a GPS fix (spec §11.4). */
export const FIX_WAIT_MS = 15_000;
/** A firing this long after it came due is labelled late (spec §11.4: "late by N min"). */
export const LATE_MS = 2 * 60_000;
const NEAR_M = 2000;
const MIN = 60_000;
/** @param {number} x */
const round6 = (x) => Math.round(x * 1e6) / 1e6;

export class Live {
  /** Live mode is on (spec §11.1). */
  on = false;
  /** @type {Fix | null} the last position */
  fix = null;
  /** @type {import('./activity.js').Activity} */
  activity = 'unknown';
  /** km travelled while walking or moving fast */
  odometer = 0;
  /** @type {import('./triggers.js').Stop | null} where the user has stayed, and since when */
  stop = null;
  /** @type {'off' | 'waiting' | 'ok' | 'denied' | 'unavailable'} */
  gps = 'off';
  /** What the GPS said when it failed. */
  gpsMessage = '';
  /** annai is on screen. */
  shown = true;
  /** The phone has a connection. */
  online = true;
  /** Name a point for the now block, besides the plan's places (the offline pack adds one). @type {((p: { lat: number, lng: number }) => { name: string, m: number } | null)[]} */
  namers = [];
  #tracker = new ActivityTracker();
  /** @type {Fix | null} the last location point kept (spec §4.5) */
  #kept = null;
  /** @type {Fix | null} where the odometer last counted from */
  #odo = null;
  /** @type {string | null | undefined} the trip whose plan is loaded; undefined: none yet */
  #trip = undefined;
  /** @type {Map<string, Watch[]>} by scope */
  #watches = new Map();
  /** @type {Watch[]} the open trip's plan watches */
  #plan = [];
  /** @type {{ name: string, lat: number, lng: number }[]} */
  #places = [];
  /** @type {Map<string, Record<string, any>>} each watch's memory, by scope and id */
  #mem = new Map();
  /** @type {Map<string, { at: number, place: any }>} each watch's last firing, from the log */
  #fired = new Map();
  /** @type {any} */
  #timer = null;
  /** @type {Promise<unknown>} */
  #work = Promise.resolve();
  /** @type {Set<() => void>} */
  #changes = new Set();
  /** @type {Set<() => void>} */
  #activityChanges = new Set();
  /** @type {Set<any>} */
  #sensorsOn = new Set();
  /** @type {Map<any, () => void>} the location sensors running, and how to stop each */
  #gpsOn = new Map();
  /** @type {(() => void)[]} */
  #offs = [];
  /** @type {{ since: number, from: Fix | null } | null} when annai went off screen, and where the user was */
  #away = null;
  /** @type {{ how: 'start' | 'shown', since: number | null, from: Fix | null, fired: Fired[], timer: any } | null} a catch-up collecting what fires (spec §11.4) */
  #catch = null;
  /** @type {{ scope: string, text: string }[]} what fired while there was no connection */
  #held = [];
  /** @type {number | null} when the connection went */
  #offlineSince = null;

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry,
   *   agent: AgentLike, clock?: import('./clock.js').Clock, timeZone?: () => string }} c
   */
  constructor({ store, ws, registry, agent, clock = realClock(), timeZone = deviceZone }) {
    this.store = store;
    this.ws = ws;
    this.registry = registry;
    this.agent = agent;
    this.clock = clock;
    this.timeZone = timeZone;
  }

  /** Follows the sensors, the watches and the plan, from the switch as it was left (choice 11). */
  async start() {
    this.on = Boolean((await readAppSettings(this.ws)).live?.on);
    this.#offs.push(
      this.registry.add('live', 'activity', {
        now: () => (this.on ? this.activity : 'unknown'),
        onChange: (/** @type {() => void} */ fn) => {
          this.#activityChanges.add(fn);
          return () => { this.#activityChanges.delete(fn); };
        },
      }),
      this.registry.add('live', 'skill', DRIVING),
      this.registry.add('live', 'skill', REPLANNING),
      this.ws.onChange((c) => this.#changed(c)),
      this.agent.on('event', (e) => this.#heard(e)),
      // Another trip opened: its plan's reminders are looked at at once, not at the next fix (spec §11.3).
      this.agent.on('open', () => this.#bg(() => this.#check())),
      this.registry.onChange(() => this.#sensors()),
    );
    await this.#run(async () => {
      await this.#loadAll();
      await this.#follow();
      const last = await this.#lastSeen();
      this.#sensors();
      await this.#catchUp({ ...last, how: 'start' });
    });
  }

  /** Stops everything it started. */
  dispose() {
    this.#gpsStop();
    this.#clearTimer();
    for (const off of this.#offs.splice(0)) {
      try {
        off();
      } catch {
        // already gone
      }
    }
  }

  /**
   * The live mode switch (spec §11.1). Turning it on wakes Shiori once, so the driving-companion
   * skill can set its watches (choice 10).
   * @param {boolean} on
   */
  async setLive(on) {
    const changed = await this.#run(async () => {
      if (on === this.on) return false;
      this.on = on;
      await updateAppSettings(this.ws, { live: { on } });
      await logEvent(this.store, this.#scope(), { type: 'state', actor: 'user', data: { live: on ? 'on' : 'off' } }, this.clock.now());
      if (on) {
        if (this.shown) this.#gpsStart();
      } else {
        this.#gpsStop();
        this.#tracker.reset();
        this.activity = 'unknown';
        this.fix = null;
        this.stop = null;
        this.gps = 'off';
        this.gpsMessage = '';
        this.#tellActivity();
      }
      this.#tell();
      await this.#check();
      return true;
    });
    if (changed && on) {
      await this.agent.wake({ kind: 'live', text: 'The user turned live mode on: annai now follows where they are with GPS, and your location watches run. If they may drive or ride, load the driving-companion skill.' });
    }
  }

  /** A position from a location sensor, a simulation, or the user. @param {any} raw */
  fixed(raw) {
    this.#bg(() => this.#onFix(raw));
  }

  /** The app went off screen, or came back (spec §11.1). @param {boolean} v */
  visible(v) {
    this.#bg(() => this.#onVisible(v));
  }

  /** The connection came or went. @param {boolean} v */
  connected(v) {
    this.#bg(() => this.#onConnected(v));
  }

  /** Where the user says they are, when there is no GPS (spec §17: "a manual place"). @param {{ lat: number, lng: number, name?: string }} p */
  place(p) {
    return this.#run(() => this.#onFix({ lat: p.lat, lng: p.lng, accuracy: 50, source: 'manual' }));
  }

  /** Settles once nothing is left to check. */
  async settled() {
    /** @type {Promise<unknown>} */
    let w;
    do {
      w = this.#work;
      await w;
    } while (w !== this.#work);
  }

  /** Hears when the position, the activity, the GPS or the switch change. @param {() => void} fn @returns {() => void} */
  onChange(fn) {
    this.#changes.add(fn);
    return () => { this.#changes.delete(fn); };
  }

  /** The trigger types: the built-in ones, then plugins' (spec §11.3: "Plugins can add types"). @returns {Map<string, TriggerType>} */
  types() {
    /** @type {Map<string, TriggerType>} */
    const out = new Map(TRIGGERS.map((t) => [t.type, t]));
    for (const e of this.registry.entries('trigger')) {
      const t = e.item;
      if (!t || typeof t.type !== 'string' || typeof t.check !== 'function' || out.has(t.type) || t.type === 'plan') continue;
      out.set(t.type, { gps: false, summary: t.type, validate: () => null, describe: () => t.type, ...t, pluginId: e.pluginId });
    }
    return out;
  }

  /**
   * Sets a watch (spec §7.2 watch.set), or throws an Error that says, in plain words, what is wrong.
   * @param {string} scope the conversation's: a trip, or "me" @param {any} i { when, fallback, repeat?, expires? } @param {string} [owner]
   * @returns {Promise<Watch>}
   */
  async setWatch(scope, i, owner = 'shiori') {
    const types = this.types();
    const when = i?.when;
    const type = typeof when?.type === 'string' ? types.get(when.type) : undefined;
    if (!type) throw new Error(`when.type must be one of: ${[...types.keys()].join(', ')}.`);
    /** @type {string | null} */
    let wrong;
    try {
      wrong = type.validate(when);
    } catch (e) {
      throw new Error(`The ${type.type} trigger couldn't check this watch (${String(/** @type {any} */ (e)?.message ?? e).replace(/\.$/, '')}). Try another kind of watch.`);
    }
    if (wrong) throw new Error(`A ${type.type} watch: ${wrong}.`);
    const fallback = typeof i.fallback === 'string' ? i.fallback.trim() : '';
    if (!fallback) throw new Error("Every watch needs a fallback: the words annai shows, and says with voice on, by itself when it fires and you can't be reached.");
    const now = this.clock.now();
    if (i.expires !== undefined && validate({ type: 'string', format: 'date-time' }, i.expires).length) throw new Error('expires must be an ISO date-time with an offset, like 2026-11-27T18:00:00-08:00.');
    if (i.expires !== undefined && Date.parse(i.expires) <= now) throw new Error(`expires ${i.expires} has already passed.`);
    if (type.type === 'time' && Date.parse(when.at) <= now) throw new Error(`${when.at} has already passed. Give a time ahead.`);
    /** @type {Watch} */
    const w = {
      id: newWatchId(), owner, when: { ...when }, repeat: type.type === 'every' || (type.type !== 'time' && i.repeat === true),
      fallback: fallback.slice(0, 500), ...(i.expires ? { expires: i.expires } : {}), created: new Date(now).toISOString(),
    };
    return this.#run(async () => {
      await saveWatch(this.ws, scope, w, owner);
      const stored = { ...w, path: watchPath(w.id) };
      this.#watches.set(scope, [...(this.#watches.get(scope) ?? []).filter((x) => x.id !== w.id), stored]);
      const m = this.#moment();
      this.#memFor(type, stored, scope, m); // it starts from where the user is now: set while inside, enter doesn't fire
      this.#schedule(m);
      return w;
    });
  }

  /** watch_set's result: what was set, and how things stand. @param {Watch} w */
  watchText(w) {
    const type = this.types().get(w.when.type);
    const parts = [`Set ${w.id}: ${this.#describe(type, w)}${w.repeat ? ', every time' : ''}${w.expires ? `, until ${w.expires}` : ''}.`];
    if (type?.gps && !this.on) parts.push('Live mode is off, so it waits until the user turns it on.');
    const here = this.nowInfo();
    parts.push(`Now: ${here.activity}; ${here.place}.`);
    return parts.join(' ');
  }

  /** The watches of a conversation, hers and (for the open trip) the plan's, as TSV (spec §7.2 watch.list). @param {string} scope */
  async listWatches(scope) {
    await this.settled();
    const types = this.types();
    const rows = [];
    for (const w of this.#watches.get(scope) ?? []) {
      rows.push([w.id, w.owner, this.#describe(types.get(w.when?.type), w), w.repeat ? 'yes' : 'no', w.fallback, w.expires ?? '', this.#lastFired(scope, w.id)]);
    }
    if (scope === this.#scope()) for (const w of this.#plan) rows.push([w.id, 'system', PLAN.describe(w.when), w.repeat ? 'yes' : 'no', w.fallback, '', this.#lastFired(scope, w.id)]);
    return rows.length ? tsv(['id', 'owner', 'when', 'repeat', 'reminder', 'expires', 'last_fired'], rows) : 'No watches.';
  }

  /** Cancels one of her watches (spec §7.2 watch.cancel). @param {string} scope @param {string} id @returns {Promise<string>} */
  async cancelWatch(scope, id) {
    if (String(id).startsWith('plan:')) throw new Error(`${id} is one of the plan's own reminders: it follows the plan. Change or remove the plan item instead.`);
    return this.#run(async () => {
      const w = (this.#watches.get(scope) ?? []).find((x) => x.id === id);
      if (!w) throw new Error(`There is no watch ${id} here. watch_list shows them.`);
      await this.#drop(scope, w, 'shiori');
      return `Cancelled ${id}.`;
    });
  }

  /** The now block's place and activity (spec §6.3). Nothing is sent anywhere to name a place (choice 14). */
  nowInfo() {
    if (!this.on) return { place: 'unknown (live mode is off, so annai has no GPS)', activity: 'unknown (live mode is off)' };
    const activity = this.#activityText();
    const f = this.fix;
    if (!f) {
      const why = this.gps === 'denied' ? 'location permission is off' : this.gps === 'unavailable' ? 'no GPS signal' : 'waiting for GPS';
      return { place: `unknown (${why})`, activity };
    }
    const near = this.near(f);
    const age = this.clock.now() - f.at;
    const how = [`±${Math.round(f.accuracy)} m`, f.source === 'manual' ? 'set by the user' : age >= 2 * MIN ? `${Math.round(age / MIN)} min ago` : ''].filter(Boolean).join(', ');
    return { place: `${near ? `near ${near.name} (${kmText(near.m)})` : 'no plan place nearby'} · ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)} (${how})`, activity };
  }

  /** The nearest named place within reach of p: the plan's, or a namer's. @param {{ lat: number, lng: number }} p */
  near(p, within = NEAR_M) {
    /** @type {{ name: string, m: number } | null} */
    let best = null;
    for (const q of this.#places) {
      const d = meters(p, q);
      if (d <= within && (!best || d < best.m)) best = { name: q.name, m: d };
    }
    for (const n of this.namers) {
      try {
        const r = n(p);
        if (r && r.m <= within && (!best || r.m < best.m)) best = r;
      } catch {
        // a namer that fails names nothing
      }
    }
    return best;
  }

  /** @returns {string} */
  #activityText() {
    const a = this.activity === 'moving-fast' ? 'moving fast' : this.activity;
    const v = this.#tracker.speed;
    return (this.activity === 'walking' || this.activity === 'moving-fast') && v !== null ? `${a}, about ${Math.round(v * 3.6)} km/h` : a;
  }

  /** The conversation open now: the trip's, or "me". */
  #scope() {
    return this.agent.target ?? ME;
  }

  /** @param {string} scope @param {string} id */
  #key(scope, id) {
    return `${scope}\n${id}`;
  }

  /** @param {string} scope @param {string} id */
  #lastFired(scope, id) {
    const f = this.#fired.get(this.#key(scope, id));
    return f ? isoInZone(f.at, this.timeZone()) : '';
  }

  /** Runs one piece of work after the others; its result, or its error, is the caller's. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  #run(fn) {
    const job = this.#work.then(fn);
    this.#work = job.catch(() => {}); // the caller hears of its own error; the work after it goes on
    return job;
  }

  /** Work nobody waits for (a sensor's news): an error is only logged. @param {() => Promise<unknown>} fn */
  #bg(fn) {
    this.#run(fn).catch((e) => console.warn('live mode: a check failed', e));
  }

  #tell() {
    for (const fn of this.#changes) {
      try {
        fn();
      } catch (e) {
        console.warn('a live mode listener failed', e);
      }
    }
  }

  #tellActivity() {
    for (const fn of this.#activityChanges) {
      try {
        fn();
      } catch (e) {
        console.warn('an activity listener failed', e);
      }
    }
  }

  /** Starts the visibility and connectivity sensors once each, and the location ones while live and on screen. */
  #sensors() {
    for (const s of this.registry.list('sensor')) {
      if (this.#sensorsOn.has(s) || (s?.kind !== 'visibility' && s?.kind !== 'connectivity') || typeof s.start !== 'function') continue;
      this.#sensorsOn.add(s);
      try {
        const off = s.start((/** @type {any} */ v) => (s.kind === 'visibility' ? this.visible(Boolean(v)) : this.connected(Boolean(v))));
        if (typeof off === 'function') this.#offs.push(off);
      } catch (e) {
        console.warn('a sensor did not start', e);
      }
    }
    if (this.on && this.shown) this.#gpsStart();
  }

  #gpsStart() {
    for (const s of this.registry.list('sensor')) {
      if (s?.kind !== 'location' || this.#gpsOn.has(s) || typeof s.start !== 'function') continue;
      if (this.gps !== 'ok') this.gps = 'waiting';
      try {
        const off = s.start((/** @type {any} */ x) => (x && typeof x === 'object' && 'error' in x ? this.#bg(async () => this.#gpsFailed(x)) : this.fixed(x)));
        this.#gpsOn.set(s, typeof off === 'function' ? off : () => {});
      } catch (e) {
        this.#gpsFailed({ error: 'unavailable', message: String(/** @type {any} */ (e)?.message ?? e) });
      }
    }
  }

  #gpsStop() {
    for (const off of this.#gpsOn.values()) {
      try {
        off();
      } catch {
        // already stopped
      }
    }
    this.#gpsOn.clear();
  }

  /** @param {{ error: string, message?: string }} x */
  #gpsFailed(x) {
    this.gps = x.error === 'denied' ? 'denied' : 'unavailable';
    this.gpsMessage = String(x.message ?? '');
    this.#tell();
  }

  /** @param {any} raw */
  async #onFix(raw) {
    if (!this.on || !this.shown) return;
    const fix = fixOf(raw, this.clock.now());
    if (!fix) return;
    await this.#follow();
    /** @type {{ from: string, to: string } | null} */
    let change = null;
    if (fix.source !== 'manual') {
      this.gps = 'ok';
      const c = this.#tracker.feed(fix);
      if (c) {
        change = { from: c.from, to: c.to };
        this.activity = c.to;
      }
    }
    if (!this.stop || meters(this.stop, fix) > Math.max(STOP_M, fix.accuracy)) this.stop = { lat: fix.lat, lng: fix.lng, since: fix.at };
    const moving = this.activity === 'walking' || this.activity === 'moving-fast';
    // Not moving (and the GPS says no speed): GPS jitter at a stop is no movement, so a point is kept
    // only once the user is truly elsewhere, beyond the stop's own 100 m (spec §4.5's "after moving").
    const goes = moving || (fix.speed ?? 0) >= STILL_BELOW;
    if (goes ? keep(this.#kept, fix, moving) : !this.#kept || meters(this.#kept, fix) >= Math.max(STOP_M, 2 * fix.accuracy)) {
      this.#kept = fix;
      if (this.#trip) await logEvent(this.store, this.#trip, { type: 'location', actor: 'system', data: pointData(fix) }, fix.at);
    }
    // The odometer counts only while moving, so GPS jitter at a stop adds nothing (choice 13); walking,
    // only steps longer than twice the accuracy, which jitter doesn't make.
    if (!this.#odo) this.#odo = fix;
    else if (moving && fix.accuracy <= 100 && meters(this.#odo, fix) >= Math.max(KEEP_M, (this.activity === 'walking' ? 2 : 1) * fix.accuracy)) {
      this.odometer += meters(this.#odo, fix) / 1000;
      this.#odo = fix;
    }
    this.fix = fix;
    if (change) this.#tellActivity();
    this.#tell();
    await this.#check({ newFix: true, change });
    if (this.#catch) await this.#endCatchUp(); // the first fix after coming back: the catch-up is complete
  }

  /** @param {boolean} v */
  async #onVisible(v) {
    if (v === this.shown) return;
    this.shown = v;
    if (!v) {
      // Off screen nothing is evaluated (spec §11.1, choice 15); catch-up covers the gap.
      this.#away = { since: this.clock.now(), from: this.fix };
      this.#gpsStop();
      this.#clearTimer();
      if (this.#catch) await this.#endCatchUp();
      this.#tell();
      return;
    }
    const away = this.#away ?? { since: this.clock.now(), from: this.fix };
    this.#away = null;
    if (this.on) this.#gpsStart();
    this.#tell();
    await this.#catchUp({ ...away, how: 'shown' });
  }

  /** @param {boolean} v */
  async #onConnected(v) {
    if (v === this.online) return;
    this.online = v;
    if (!v) this.#offlineSince = this.clock.now();
    this.#tell();
    if (!v) return;
    const since = this.#offlineSince ?? this.clock.now();
    this.#offlineSince = null;
    const held = this.#held.splice(0);
    /** @type {Map<string, string[]>} */
    const by = new Map();
    for (const h of held) by.set(h.scope, [...(by.get(h.scope) ?? []), h.text]);
    for (const [scope, texts] of by) {
      const text = `While there was no connection (for ${span(this.clock.now() - since)}, since ${timeIn(since, this.timeZone())}), these came, and annai showed their reminders by itself: ${texts.join(' ')}`;
      await this.agent.wake({ kind: 'trigger', text, fallbacks: [], ...(scope === this.#scope() ? {} : { scope }) });
    }
  }

  /** When annai last ran in the open conversation, and the last point it kept (spec §11.4, after a restart). */
  async #lastSeen() {
    const scope = this.#scope();
    const [last] = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { reverse: true, limit: 1 }));
    const [point] = this.#trip ? await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['location'], reverse: true, limit: 1 })) : [];
    const from = point ? fixOf({ ...point.data, at: point.ts }, point.ts) : null;
    if (from) {
      this.#kept = from;
      this.#odo = from; // the distance from there counts once the user moves
    }
    return { since: last ? last.ts : null, from };
  }

  /**
   * Catch-up (spec §11.4). First, from where the user was when annai went away, what the clock made
   * due fires late; then, with the first fix (or after FIX_WAIT_MS without one), arriving and
   * leaving are inferred from there against here. Everything goes into one catch-up wake.
   * @param {{ how: 'start' | 'shown', since: number | null, from: Fix | null }} gap
   */
  async #catchUp(gap) {
    if (this.#catch) await this.#endCatchUp();
    const c = { ...gap, fired: /** @type {Fired[]} */ ([]), timer: /** @type {any} */ (null) };
    this.#catch = c;
    await this.#check({ past: true });
    if (this.on && this.shown && this.#gpsOn.size && this.gps !== 'denied') {
      c.timer = this.clock.set(() => {
        this.#bg(async () => {
          if (this.#catch === c) await this.#endCatchUp();
        });
      }, FIX_WAIT_MS);
    } else {
      await this.#endCatchUp();
    }
  }

  async #endCatchUp() {
    const c = this.#catch;
    if (!c) return;
    this.#catch = null;
    if (c.timer !== null) this.clock.clear(c.timer);
    if (c.fired.length) await this.#deliver(c.fired, 'catch-up', this.#catchUpHeader(c));
  }

  /** "Catch-up: annai was off screen for 47 min (since 15:18), and the user moved 17.0 km from near … to near …." @param {{ how: 'start' | 'shown', since: number | null, from: Fix | null }} c */
  #catchUpHeader(c) {
    const now = this.clock.now();
    const was = c.how === 'start' ? 'closed' : 'off screen';
    const head = c.since === null ? 'Catch-up: annai has just started' : `Catch-up: annai was ${was} for ${span(now - c.since)} (since ${timeIn(c.since, this.timeZone())})`;
    const moved = c.from && this.fix && this.fix !== c.from ? meters(c.from, this.fix) : 0;
    if (moved < 500 || !c.from || !this.fix) return `${head}.`;
    const a = this.near(c.from);
    const b = this.near(this.fix);
    return `${head}, and the user moved ${kmText(moved)}${a ? ` from near ${a.name}` : ''}${b ? ` to near ${b.name}` : ''}.`;
  }

  /** A wake of hers: moved counts again from here (spec §11.3: "X km travelled since the last wake"). @param {any} e */
  #heard(e) {
    if (e?.type !== 'wake' || e.data?.meanwhile) return;
    const prefix = `${e.scope ?? this.#scope()}\n`;
    for (const [key, mem] of this.#mem) if (key.startsWith(prefix)) mem.km0 = this.odometer;
  }

  /** A watch or the plan changed on disk. @param {{ scope: string, path: string }} c */
  #changed(c) {
    if (WATCH_FILE.test(c.path)) {
      this.#bg(async () => {
        await this.#loadScope(c.scope);
        await this.#check();
      });
    } else if (c.scope === this.#trip && (PLAN_FILE.test(c.path) || BOOKING_FILE.test(c.path))) {
      this.#bg(async () => {
        await this.#loadPlan();
        await this.#check();
      });
    }
  }

  /** Another conversation opened: its plan, and everyone's watches afresh. */
  async #follow() {
    const trip = this.agent.target;
    if (trip === this.#trip) return;
    const first = this.#trip === undefined;
    this.#trip = trip;
    this.#kept = null;
    this.stop = null;
    if (!first) await this.#loadAll();
    await this.#loadPlan();
  }

  /** Every conversation's watches, and what has fired. */
  async #loadAll() {
    const { active } = await listTrips(this.store);
    const scopes = [ME, ...active.map((s) => s.id)];
    this.#watches.clear();
    for (const scope of scopes) {
      await this.#loadScope(scope);
      for (const e of await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['trigger.fired'] }))) {
        this.#fired.set(this.#key(scope, String(e.data?.watch)), { at: e.ts, place: e.data?.place ?? null });
      }
    }
  }

  /** @param {string} scope */
  async #loadScope(scope) {
    const { watches } = await readWatches(this.ws, scope);
    if (watches.length) this.#watches.set(scope, watches);
    else this.#watches.delete(scope);
  }

  /** The open trip's plan, as the plan's own watches. */
  async #loadPlan() {
    const trip = this.#trip;
    this.#plan = [];
    this.#places = [];
    if (!trip) return;
    /** @type {{ path: string, item: any }[]} */
    const items = [];
    /** @type {Map<string, any>} */
    const bookings = new Map();
    for (const f of await this.ws.list(trip, '/plan/')) {
      if (!PLAN_FILE.test(f.path)) continue;
      const item = await this.ws.readJSON(trip, f.path).catch(() => null);
      if (item && typeof item === 'object') items.push({ path: f.path, item });
    }
    for (const f of await this.ws.list(trip, '/bookings/')) {
      if (!BOOKING_FILE.test(f.path)) continue;
      const b = await this.ws.readJSON(trip, f.path).catch(() => null);
      if (b && typeof b === 'object') bookings.set(f.path, b);
    }
    const info = await this.ws.readJSON(trip, '/trip.json').catch(() => null);
    const fallbackTz = [info?.timezones?.[0], this.timeZone()].find(validZone) ?? 'UTC';
    this.#plan = planWatches(items, bookings, { fallbackTz });
    for (const { item } of items) {
      const p = item.place;
      if (p && typeof p.lat === 'number' && typeof p.lng === 'number') this.#places.push({ name: String(p.name ?? item.title ?? 'a plan place'), lat: p.lat, lng: p.lng });
    }
  }

  /** The moment checks see. @param {{ newFix?: boolean, change?: { from: string, to: string } | null, past?: boolean }} [o] @returns {Moment} */
  #moment(o = {}) {
    const now = this.clock.now();
    const c = this.#catch;
    // A catch-up's first look sees where the user was when annai went away (spec §11.4).
    const past = Boolean(o.past) && c !== null;
    const f = past && c ? c.from : this.fix;
    const fix = this.on && f && (past || f.source === 'manual' || now - f.at <= FRESH_MS) ? f : null;
    const scope = this.#scope();
    return {
      now, fix, newFix: !past && Boolean(o.newFix) && Boolean(fix), past, live: this.on, activity: this.on ? this.activity : 'unknown', change: o.change ?? null,
      odometer: this.odometer, stop: this.on && !past ? this.stop : null, gap: c ? { since: c.since, from: c.from } : null,
      fired: (id) => this.#fired.has(this.#key(scope, id)),
    };
  }

  /** The watch's memory, made the first time it is seen (spec §11.3: it starts from now). @param {TriggerType} type @param {Watch} w @param {string} scope @param {Moment} m */
  #memFor(type, w, scope, m) {
    const key = this.#key(scope, w.id);
    let mem = this.#mem.get(key);
    if (mem) return mem;
    const last = this.#fired.get(key);
    mem = { set: Date.parse(w.created ?? '') || m.now, lastAt: last?.at ?? null, lastPlace: last?.place ?? null, km0: this.odometer };
    this.#mem.set(key, mem);
    try {
      type.start?.(w.when, m, mem);
    } catch {
      // a type that can't start just waits
    }
    return mem;
  }

  /** One check of one watch; a plugin's trigger that throws counts against its plugin (spec §5.5). @param {TriggerType} type @param {Watch} w @param {string} scope @param {Moment} m */
  #try(type, w, scope, m) {
    const mem = this.#memFor(type, w, scope, m);
    try {
      return type.check(w.when, m, mem) ?? null;
    } catch (e) {
      if (type.pluginId) this.registry.fail(type.pluginId, `trigger ${type.type}`, e);
      else console.warn(`the trigger ${type.type} failed`, e);
      return null;
    }
  }

  /** Whether a watch is looked at now: its conversation's, live mode for GPS, and time watches anywhere (choices 2 and 3). @param {TriggerType | undefined} type @param {string} scope */
  #looked(type, scope) {
    return Boolean(type) && !(type?.gps && !this.on) && (scope === this.#scope() || type?.type === 'time');
  }

  /** Looks at every watch now (spec §11.3), fires what is due as one wake, and sets the clock for the next. @param {{ newFix?: boolean, change?: { from: string, to: string } | null, past?: boolean }} [o] */
  async #check(o = {}) {
    await this.#follow();
    const m = this.#moment(o);
    const open = this.#scope();
    const types = this.types();
    /** @type {Fired[]} */
    const fired = [];
    for (const [scope, list] of [...this.#watches]) {
      for (const w of [...list]) {
        if (expired(w, m.now)) {
          await this.#drop(scope, w);
          continue;
        }
        const type = types.get(w.when?.type);
        if (!type || !this.#looked(type, scope) || this.#broken(type, w)) continue; // a broken watch never fires; watch_list says why
        const f = this.#try(type, w, scope, m);
        if (f) fired.push(this.#firedOf(scope, w, type, f, m.now));
      }
    }
    for (const w of this.#plan) {
      if (!w.repeat && this.#fired.has(this.#key(open, w.id))) continue;
      const f = this.#try(PLAN, w, open, m);
      if (f) fired.push(this.#firedOf(open, w, PLAN, f, m.now));
    }
    if (fired.length) await this.#fire(fired, m.now);
    this.#schedule(m);
  }

  /** @param {string} scope @param {Watch} watch @param {TriggerType} type @param {Firing} firing @param {number} now @returns {Fired} */
  #firedOf(scope, watch, type, firing, now) {
    const late = this.#catch && firing.at !== undefined && now - firing.at >= LATE_MS ? Math.round((now - firing.at) / MIN) : 0;
    return { scope, watch, type, firing, late, ...(this.#catch ? { away: this.#catch.how } : {}), fallback: firing.fallback ?? watch.fallback };
  }

  /** Logs each firing, then wakes Shiori: one wake a conversation (spec §6.1). @param {Fired[]} list @param {number} now */
  async #fire(list, now) {
    const open = this.#scope();
    /** @type {Fired[]} */
    const done = [];
    for (const x of list) {
      if (x.scope !== open && !(await this.#exists(x.scope))) {
        this.#watches.delete(x.scope); // a trip that was removed: nothing more goes into it (spec §4.9)
        continue;
      }
      const key = this.#key(x.scope, x.watch.id);
      const f = x.firing;
      await logEvent(this.store, x.scope, {
        type: 'trigger.fired', actor: 'system',
        data: {
          watch: x.watch.id, type: x.watch.when.type, ...(x.watch.when.event ? { event: x.watch.when.event } : {}), owner: x.watch.owner, text: f.text, fallback: x.fallback,
          ...(x.late ? { late: x.late } : {}), ...(f.place ? { place: f.place } : {}), ...(this.#catch ? { catchUp: true } : {}), ...(this.online ? {} : { offline: true }),
        },
      }, now);
      this.#fired.set(key, { at: now, place: f.place ?? null });
      const mem = this.#mem.get(key);
      if (mem) {
        mem.lastAt = now;
        mem.km0 = this.odometer;
        if (f.place) mem.lastPlace = f.place;
      }
      if (x.watch.owner !== 'system' && (x.watch.when.type === 'time' || (!x.watch.repeat && x.watch.when.type !== 'every'))) await this.#drop(x.scope, x.watch);
      done.push(x);
    }
    if (this.#catch) this.#catch.fired.push(...done);
    else if (done.length) await this.#deliver(done);
  }

  /**
   * Wakes Shiori for what fired. In another conversation (a time watch of a trip that isn't open):
   * its reminders now, and the wake written into it for when it opens (choice 3).
   * @param {Fired[]} list @param {'trigger' | 'catch-up'} [kind] @param {string} [header]
   */
  async #deliver(list, kind = 'trigger', header = '') {
    const open = this.#scope();
    /** @type {Map<string, Fired[]>} */
    const by = new Map();
    for (const x of list) by.set(x.scope, [...(by.get(x.scope) ?? []), x]);
    for (const [scope, xs] of by) {
      const reasons = xs.map((x) => this.#reason(x));
      const fallbacks = xs.map((x) => ({ watch: x.watch.id, text: x.fallback }));
      if (scope !== open) {
        await this.agent.remind(fallbacks, scope);
        await this.agent.wake({ kind, text: reasons.join(' '), scope });
        continue;
      }
      const text = [header, ...reasons].filter(Boolean).join(' ');
      if (!this.online) {
        // No connection: annai says the reminders itself now; Shiori hears of them when it is back (spec §17, choice 8).
        await this.agent.remind(fallbacks);
        this.#held.push({ scope, text });
        continue;
      }
      await this.agent.wake({ kind, text, fallbacks });
    }
  }

  /** What fired, in words for Shiori's wake. @param {Fired} x */
  #reason(x) {
    const late = x.late ? ` (late by ${x.late} min: annai was ${x.away === 'start' ? 'closed' : 'off screen'})` : '';
    if (x.watch.owner === 'system') return `${x.firing.text}${late}.`;
    const whose = x.watch.owner === 'shiori' ? 'Your watch' : `The watch of ${x.watch.owner}`;
    return `${whose} ${x.watch.id} (${this.#describe(x.type, x.watch)}) fired: ${x.firing.text}${late}. Its reminder: "${x.watch.fallback}"`;
  }

  /** @param {string} scope */
  async #exists(scope) {
    return scope === ME || Boolean(await this.store.tx(['scopes'], 'readonly', (t) => t.getScope(scope)));
  }

  /** What is wrong with a watch, in plain words, or null (a file can say anything; spec §4.4). @param {TriggerType} type @param {Watch} w */
  #broken(type, w) {
    try {
      const wrong = type.validate(w.when);
      return typeof wrong === 'string' && wrong ? wrong : null;
    } catch {
      return `its ${type.type} trigger can't read it`;
    }
  }

  /** A watch's when, in words, whatever is in it; never throws. @param {TriggerType | undefined} type @param {Watch} w */
  #describe(type, w) {
    if (!type) return `${String(w.when?.type)} (its trigger type isn't installed)`;
    const a = `${/^[aeiou]/i.test(type.type) ? 'an' : 'a'} ${type.type} watch`;
    const wrong = this.#broken(type, w);
    if (wrong) return `${a}, broken: ${wrong}, so it won't fire`;
    try {
      return String(type.describe(w.when));
    } catch {
      return a;
    }
  }

  /** Removes a watch: fired once, cancelled, or expired. @param {string} scope @param {Watch} w */
  async #drop(scope, w, author = 'system') {
    this.#watches.set(scope, (this.#watches.get(scope) ?? []).filter((x) => x.id !== w.id));
    this.#mem.delete(this.#key(scope, w.id));
    if (await this.#exists(scope)) await removeWatch(this.ws, scope, w, author);
  }

  /** One timer, for the next due watch (spec §11.2); while live, at least once a minute. Off screen, none. @param {Moment} m */
  #schedule(m) {
    this.#clearTimer();
    if (!this.shown) return;
    let next = this.on ? m.now + RECHECK_MS : Infinity;
    const consider = (/** @type {number | null | undefined} */ t) => {
      if (typeof t === 'number' && Number.isFinite(t) && t > m.now && t < next) next = t;
    };
    const types = this.types();
    const open = this.#scope();
    for (const [scope, list] of this.#watches) {
      for (const w of list) {
        if (w.expires) consider(Date.parse(w.expires));
        const type = types.get(w.when?.type);
        const mem = this.#mem.get(this.#key(scope, w.id));
        if (!type?.next || !mem || !this.#looked(type, scope) || this.#broken(type, w)) continue;
        try {
          consider(type.next(w.when, m, mem));
        } catch {
          // a type that can't say when waits for the next fix
        }
      }
    }
    for (const w of this.#plan) {
      const mem = this.#mem.get(this.#key(open, w.id));
      if (mem && (w.repeat || !this.#fired.has(this.#key(open, w.id)))) consider(PLAN.next?.(w.when, m, mem));
    }
    if (next === Infinity) return;
    this.#timer = this.clock.set(() => {
      this.#timer = null;
      this.#bg(() => this.#check());
    }, Math.min(next - m.now, MAX_WAIT_MS));
  }

  #clearTimer() {
    if (this.#timer !== null) this.clock.clear(this.#timer);
    this.#timer = null;
  }
}

/** A location point as the log keeps it (spec §4.5). @param {Fix} f */
function pointData(f) {
  return {
    lat: round6(f.lat), lng: round6(f.lng), accuracy: Math.round(f.accuracy),
    ...(f.speed !== null ? { speed: Math.round(f.speed * 10) / 10 } : {}), ...(f.heading !== null ? { heading: Math.round(f.heading) } : {}),
    ...(f.source !== 'gps' ? { source: f.source } : {}),
  };
}
