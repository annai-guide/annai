import { meters, keep, fixOf, kmText, span, KEEP_M } from './geo.js';
import { ActivityTracker, STILL_BELOW } from './activity.js';
import { TRIGGERS } from './triggers.js';
import { PLAN, planWatches } from './plan-watches.js';
import { readWatches, saveWatch, removeWatch, newWatchId, expired, watchPath, WATCH_FILE } from './watches.js';
import { realClock } from './clock.js';
import { readAppSettings, updateAppSettings } from '../settings.js';
import { logEvent } from '../events.js';
import { ME, listTrips } from '../scopes.js';
import { PLAN_FILE, BOOKING_FILE } from '../plan.js';
import { validZone, deviceZone, isoInZone, timeIn } from '../time.js';
import { validate } from '../schema.js';
import { tsv } from '../tsv.js';
import { isPluginBug } from '../plugins.js';
import { isArrival } from '../after/stamps.js';
import { SIMULATION } from './simulate.js';

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
 * @typedef {{ key: string, scope: string, watch: string, due: number, text: string }} Mirrored
 *   a reminder a closed annai can still give through the push relay (spec §11.6): key names it and, for the plan's, the item's time
 * @typedef {{ kind: 'shown' | 'opened' | 'changed', key?: string, scope?: string, watch?: string, at?: number, title?: string, body?: string, test?: boolean, t?: number }} PushNews
 *   what the service worker saw: a notification shown or opened, or the subscription renewed; t, when
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
/** An arrival's place is named for its stamp (spec §13) by a plan place this close… */
export const STAMP_PLAN_M = 300;
/** …or by a place a namer (the offline pack) knows this close (choice 1). */
export const STAMP_POI_M = 500;
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
  /** @type {Map<string, { at: number, place: any, for?: number }>} each watch's last firing, from the log; for: the plan item's time it was for */
  #fired = new Map();
  /** @type {Set<string>} problems already noted in a log, so each is noted once */
  #noted = new Set();
  /** @type {Set<string>} live mode's own failures already told, so each is told once */
  #told = new Set();
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
  /** @type {Set<(level: 'calm' | 'prompt' | 'urgent') => void>} */
  #reminderChanges = new Set();
  /** The watches and the plan are loaded (start). */
  #loaded = false;
  /** start() is starting the sensors: what they say at once is so before its catch-up (fix pass L3). */
  #starting = false;
  /** @type {Map<string, number>} reminders whose notification the phone showed, by key: when (spec §11.6) */
  #notified = new Map();
  /** @type {{ scope: string, text: string }[]} notifications the user opened, for the next catch-up wake */
  #openedNews = [];
  /** @type {Set<string>} reminders annai said itself on screen, by key: a notification for one is a double (6b choice 3) */
  #said = new Set();
  /** @type {{ clock: import('./clock.js').Clock, timeZone: () => string, trip: string } | null} while a simulation runs: the device's clock and zone, and the simulation's trip */
  #sim = null;
  /** @type {Set<string>} simulations' trips (trip.json "simulation": true), still outside their run */
  #still = new Set();

  /**
   * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, registry: import('../registry.js').Registry,
   *   agent: AgentLike, clock?: import('./clock.js').Clock, timeZone?: () => string, news?: () => Promise<PushNews[]>, problem?: (e: unknown) => void }} c
   *   news: what the service worker saw while annai was away, read at each catch-up (spec §11.6);
   *   problem: live mode's own work failed (a log that can't be written), for a card: each kind is told once
   */
  constructor({ store, ws, registry, agent, clock = realClock(), timeZone = deviceZone, news = async () => [], problem = () => {} }) {
    this.store = store;
    this.ws = ws;
    this.registry = registry;
    this.agent = agent;
    this.clock = clock;
    this.timeZone = timeZone;
    this.news = news;
    this.problem = problem;
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
      this.ws.onChange((c) => this.#changed(c)),
      this.agent.on('event', (e) => this.#heard(e)),
      // Another trip opened: its plan's reminders are looked at at once, not at the next fix (spec §11.3).
      this.agent.on('open', () => this.#bg(async () => {
        await this.#check();
        this.#tellReminders('prompt');
      })),
      this.registry.onChange(() => this.#sensors()),
    );
    await this.#run(async () => {
      await this.#loadAll();
      await this.#follow();
      this.#loaded = true;
      const last = await this.#lastSeen();
      this.#starting = true;
      try {
        this.#sensors();
      } finally {
        this.#starting = false;
      }
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

  /** What live mode remembers of watches, their memories and last firings, by scope and id: only for watches there are. */
  get held() {
    return [...new Set([...this.#mem.keys(), ...this.#fired.keys()])];
  }

  /** A simulation has live mode now (spec §13). */
  get simulating() {
    return this.#sim !== null;
  }

  /**
   * A simulation takes live mode over (spec §13: "feeds a … GPS track and clock through the same
   * machinery", choice 10): its clock and zone, and only its own sensors (the phone's GPS stops; the
   * phone's visibility and connection aren't heard), from nothing known; live mode is then on for it
   * through setLive without saving the switch, and does nothing while another trip is open. The
   * function returned gives live mode back as it was.
   * @param {{ clock: import('./clock.js').Clock, timeZone: () => string, trip: string }} s trip: the simulation's own
   * @returns {Promise<() => Promise<void>>}
   */
  async simulate({ clock, timeZone, trip }) {
    await this.#run(async () => {
      if (this.#sim) throw new Error('A simulation is already running.');
      this.#gpsStop();
      this.#quiet();
      this.#sim = { clock: this.clock, timeZone: this.timeZone, trip };
      this.clock = clock;
      this.timeZone = timeZone;
      this.#fresh(false);
      // Its trip's plan and watches are in play now (they were still while it was being opened).
      await this.#loadScope(trip);
      if (this.#trip === trip) await this.#loadPlan();
      await this.#check();
    });
    let given = false;
    return async () => {
      if (given) return;
      given = true;
      await this.#run(async () => {
        const was = this.#sim;
        if (!was) return;
        this.#gpsStop();
        this.#quiet();
        this.#sim = null;
        this.clock = was.clock;
        this.timeZone = was.timeZone;
        this.#fresh(Boolean((await readAppSettings(this.ws)).live?.on));
        // Its trip is still again: its watches and plan wait for no real clock.
        await this.#loadScope(was.trip);
        await this.#loadPlan();
        if (this.on && this.shown) this.#gpsStart();
        await this.#check();
        this.#tellReminders('prompt'); // the relay follows real time again
      });
    };
  }

  /** Stops the timer and any catch-up, on the clock they were set on. */
  #quiet() {
    this.#clearTimer();
    if (this.#catch && this.#catch.timer !== null) this.clock.clear(this.#catch.timer);
    this.#catch = null;
  }

  /** Nothing known of where the user is or has been, as a simulation starts or ends. @param {boolean} on */
  #fresh(on) {
    this.on = on;
    this.fix = null;
    this.activity = 'unknown';
    this.odometer = 0;
    this.stop = null;
    this.gps = 'off';
    this.gpsMessage = '';
    this.shown = true;
    this.online = true;
    this.#tracker.reset();
    this.#kept = null;
    this.#odo = null;
    this.#away = null;
    this.#held = [];
    this.#offlineSince = null;
    this.#mem.clear();
    this.#tell();
    this.#tellActivity();
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
      if (!this.#sim) await updateAppSettings(this.ws, { live: { on } }); // a simulation's switch isn't the user's (choice 10)
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
      this.#tellReminders('prompt');
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

  /**
   * What a closed annai can still say through the push relay (spec §11.6, 6b choices 1 and 2): time
   * watches in every conversation, and the open trip's "coming up" and "leave soon", each at the time
   * the phone itself would say it. Null until live mode has loaded, and while a simulation runs: its
   * reminders are its own, on its clock, and the user's stay at the relay as they are (M6×M7). Read in
   * its own queue, so never half of a list being reloaded, with the plan of the trip open now.
   * @returns {Promise<Mirrored[] | null>}
   */
  reminders() {
    return this.#run(async () => {
      if (!this.#loaded || this.#sim) return null;
      await this.#follow(); // a trip being opened: its own plan, never the last one's under its name
      const m = this.#moment();
      const time = this.types().get('time');
      /** @type {Mirrored[]} */
      const out = [];
      for (const [scope, list] of this.#watches) {
        if (!this.#inPlay(scope)) continue; // a simulation's own trip, outside its run
        for (const w of list) {
          if (w.when?.type !== 'time' || !time || this.#broken(time, w)) continue;
          const due = Date.parse(w.when.at);
          if (Number.isFinite(due) && !expired(w, due)) out.push({ key: this.#keyOf(scope, w), scope, watch: w.id, due, text: w.fallback });
        }
      }
      const open = this.#scope();
      for (const w of this.#inPlay(open) ? this.#plan : []) {
        const event = /** @type {any} */ (w.when).event;
        if ((event !== 'coming-up' && event !== 'leave') || this.#spent(open, w)) continue;
        /** @type {number | null} */
        let due = null;
        try {
          due = PLAN.next?.(w.when, m, this.#mem.get(this.#key(open, w.id)) ?? {}) ?? null;
        } catch {
          due = null;
        }
        if (typeof due === 'number' && Number.isFinite(due)) out.push({ key: this.#keyOf(open, w), scope: open, watch: w.id, due, text: w.fallback });
      }
      return out.sort((a, b) => a.due - b.due);
    });
  }

  /** Hears when what reminders() says may have changed, and how much (#tellReminders). @param {(level: 'calm' | 'prompt' | 'urgent') => void} fn @returns {() => void} */
  onReminders(fn) {
    this.#reminderChanges.add(fn);
    return () => { this.#reminderChanges.delete(fn); };
  }

  /** A trip was removed (spec §4.9): its watches, memory and firings leave live mode at once. @param {string} scope */
  forget(scope) {
    return this.#run(async () => {
      this.#watches.delete(scope);
      const prefix = `${scope}\n`;
      for (const k of [...this.#mem.keys()]) if (k.startsWith(prefix)) this.#mem.delete(k);
      for (const k of [...this.#fired.keys()]) if (k.startsWith(prefix)) this.#fired.delete(k);
      this.#tellReminders('urgent');
    });
  }

  /**
   * A trip was archived or unarchived: an archived trip's watches and plan remind of nothing, so they
   * leave live mode, and the push relay, at once; an unarchived one's come back.
   */
  tripsChanged() {
    return this.#run(async () => {
      await this.#loadAll();
      await this.#loadPlan();
      await this.#check();
      this.#tellReminders('urgent');
    });
  }

  /**
   * The service worker says something happened while annai is on screen: its news is read in live
   * mode's own queue, after any catch-up that read it first, so a tap is told once (fix pass N2).
   * @returns {Promise<string[]>} the doubles, as pushNews
   */
  newsArrived() {
    return this.#run(async () => {
      const doubles = await this.#hear(await this.#readNews());
      if (!this.#catch) await this.#deliverOpened();
      return doubles;
    });
  }

  /**
   * What the service worker saw while annai is on screen (spec §11.6): opened notifications become a
   * catch-up wake now, or join the one running. Returns the keys of shown notifications for reminders
   * annai had already said itself on screen, for the page to close (6b choice 3).
   * @param {PushNews[]} list @returns {Promise<string[]>}
   */
  pushNews(list) {
    return this.#run(async () => {
      const doubles = await this.#hear(list);
      if (!this.#catch) await this.#deliverOpened();
      return doubles;
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

  /** Work nobody waits for (a sensor's news): an error is told (#fail). @param {() => Promise<unknown>} fn */
  #bg(fn) {
    this.#run(fn).catch((e) => this.#fail(e));
  }

  /** Live mode's own work failed: told once for each problem, so a card says so (spec §17 rule 4), and it goes on. @param {unknown} e */
  #fail(e) {
    const key = String(/** @type {any} */ (e)?.message ?? e);
    if (this.#told.has(key)) return;
    this.#told.add(key);
    console.warn('live mode: a check failed', e);
    try {
      this.problem(e);
    } catch {
      // whoever is told can't stop live mode
    }
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

  /**
   * Tells what may have changed in reminders(): calm, times may have moved; prompt, a reminder came or
   * changed; urgent, one went (said, cancelled, its trip removed). @param {'calm' | 'prompt' | 'urgent'} level
   */
  #tellReminders(level) {
    for (const fn of this.#reminderChanges) {
      try {
        fn(level);
      } catch (e) {
        console.warn('a reminders listener failed', e);
      }
    }
  }

  /** A reminder's name at the relay: its conversation, its watch, and for the plan's, the item's time. @param {string} scope @param {Watch} w */
  #keyOf(scope, w) {
    const f = forAt(w);
    return f === null ? `${scope}|${w.id}` : `${scope}|${w.id}|${f}`;
  }

  /** The service worker's news, never failing. @returns {Promise<PushNews[]>} */
  async #readNews() {
    try {
      const list = await this.news();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /**
   * Takes in the service worker's news: shown ones are told with the firing they were for, opened
   * ones wait for a wake. A removed trip's, and annai's own test notifications, are dropped.
   * @param {PushNews[]} list @returns {Promise<string[]>} the doubles
   */
  async #hear(list) {
    // The phone's own notifications keep real time, whatever clock a simulation runs on.
    const now = (this.#sim?.clock ?? this.clock).now();
    const zone = this.#sim?.timeZone ?? this.timeZone;
    for (const [k, t] of this.#notified) if (now - t > 86_400_000) this.#notified.delete(k);
    /** @type {string[]} */
    const doubles = [];
    for (const n of Array.isArray(list) ? list : []) {
      if (!n || typeof n !== 'object' || n.test || typeof n.key !== 'string' || typeof n.scope !== 'string' || !n.scope) continue;
      if (n.kind !== 'shown' && n.kind !== 'opened') continue;
      if (!(await this.#exists(n.scope))) continue;
      const t = typeof n.t === 'number' && Number.isFinite(n.t) ? n.t : now;
      if (n.kind === 'shown') {
        this.#notified.set(n.key, t);
        if (this.#said.has(n.key)) doubles.push(n.key);
      } else {
        const words = String(n.body ?? '').trim().slice(0, 300);
        this.#openedNews.push({ scope: n.scope, text: `The user opened the reminder ${words ? `"${words}"` : `for ${String(n.watch ?? 'a watch')}`} from its notification at ${timeIn(t, zone())}.` });
      }
      await logEvent(this.store, n.scope, { type: n.kind === 'shown' ? 'push.shown' : 'push.opened', actor: 'system', data: { key: n.key, watch: String(n.watch ?? ''), at: t } }, now);
    }
    return doubles;
  }

  /** Opened notifications with no catch-up running: a catch-up wake of their own, in each one's conversation. */
  async #deliverOpened() {
    /** @type {Map<string, string[]>} */
    const by = new Map();
    for (const o of this.#openedNews.splice(0)) by.set(o.scope, [...(by.get(o.scope) ?? []), o.text]);
    for (const [scope, lines] of by) {
      const text = `Catch-up: ${lines.join(' ').replace(/^The user/, 'the user')}`;
      await this.agent.wake({ kind: 'catch-up', text, ...(scope === this.#scope() ? {} : { scope }) });
    }
  }

  /** Starts the visibility and connectivity sensors once each, and the location ones while live and on screen. */
  #sensors() {
    for (const { pluginId, item: s } of this.registry.entries('sensor')) {
      if (this.#sensorsOn.has(s) || (s?.kind !== 'visibility' && s?.kind !== 'connectivity') || typeof s.start !== 'function') continue;
      this.#sensorsOn.add(s);
      try {
        const off = s.start((/** @type {any} */ v) => {
          if (!this.#heeds(pluginId)) return;
          if (this.#starting) this.#first(s.kind, Boolean(v));
          else if (s.kind === 'visibility') this.visible(Boolean(v));
          else this.connected(Boolean(v));
        });
        if (typeof off === 'function') this.#offs.push(off);
      } catch (e) {
        console.warn('a sensor did not start', e);
      }
    }
    if (this.on && this.shown) this.#gpsStart();
  }

  /**
   * What a sensor says as annai starts is so at once, before the start's catch-up: started off screen,
   * nothing is said on screen (its firings aren't marked said); started offline, annai says the reminders itself.
   * @param {'visibility' | 'connectivity'} kind @param {boolean} v
   */
  #first(kind, v) {
    if (kind === 'visibility') this.shown = v;
    else if (v !== this.online) {
      this.online = v;
      this.#offlineSince = v ? null : this.clock.now();
    }
  }

  /** While a simulation runs, only its sensors are heard (choice 10). @param {string} pluginId */
  #heeds(pluginId) {
    return !this.#sim || pluginId === SIMULATION;
  }

  /**
   * Whether live mode looks at a conversation's watches and plan, and records the road into it: during a
   * simulation only its own trip (the user's watches wait for the real clock); otherwise any but a
   * simulation's trip, which keeps what its run did (review 1, 4).
   * @param {string} scope
   */
  #inPlay(scope) {
    return this.#sim ? scope === this.#sim.trip : !this.#still.has(scope);
  }

  /** A simulation runs, and the open trip isn't its own: nothing of it may go there (choice 10). */
  #elsewhere() {
    return this.#sim !== null && this.agent.target !== this.#sim.trip;
  }

  #gpsStart() {
    for (const { pluginId, item: s } of this.registry.entries('sensor')) {
      if (s?.kind !== 'location' || this.#gpsOn.has(s) || typeof s.start !== 'function' || !this.#heeds(pluginId)) continue;
      if (this.gps !== 'ok') this.gps = 'waiting';
      try {
        const off = s.start((/** @type {any} */ x) => {
          if (!this.#heeds(pluginId)) return;
          if (x && typeof x === 'object' && 'error' in x) this.#bg(async () => this.#gpsFailed(x));
          else this.fixed(x);
        });
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
    if (!this.on || !this.shown || this.#elsewhere()) return;
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
      // A point that can't be written is told, and the checks go on (reminders don't wait for the log).
      if (this.#trip && this.#inPlay(this.#trip)) await logEvent(this.store, this.#trip, { type: 'location', actor: 'system', data: pointData(fix) }, fix.at).catch((e) => this.#fail(e));
    }
    // The odometer counts only while moving, so GPS jitter at a stop adds nothing (choice 13); walking,
    // only steps longer than twice the accuracy, which jitter doesn't make. The first fix after annai was
    // away counts the way since then at once, in the catch-up (spec §11.4), not as a jump when the user next moves.
    // Only while the catch-up waits for it: a first fix after FIX_WAIT_MS counts as any fix does.
    const back = this.#catch !== null;
    if (!this.#odo) this.#odo = fix;
    else if ((moving || back) && fix.accuracy <= 100 && meters(this.#odo, fix) >= (back ? Math.max(STOP_M, 2 * fix.accuracy) : Math.max(KEEP_M, (this.activity === 'walking' ? 2 : 1) * fix.accuracy))) {
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
    // What the phone's notifications did meanwhile, before the firings that may be theirs (spec §11.6).
    await this.#hear(await this.#readNews());
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
    const opened = this.#openedNews.splice(0);
    if (c.fired.length || opened.length) await this.#deliver(c.fired, 'catch-up', this.#catchUpHeader(c), opened);
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
        this.#prune();
        await this.#check();
        this.#tellReminders('prompt');
      });
    } else if (c.scope === this.#trip && (PLAN_FILE.test(c.path) || BOOKING_FILE.test(c.path))) {
      this.#bg(async () => {
        await this.#loadPlan();
        await this.#check();
        this.#tellReminders('prompt');
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
        this.#fired.set(this.#key(scope, String(e.data?.watch)), { at: e.ts, place: e.data?.place ?? null, ...(typeof e.data?.for === 'number' ? { for: e.data.for } : {}) });
      }
    }
  }

  /** @param {string} scope */
  async #loadScope(scope) {
    // A simulation's trip: its watches are its run's alone.
    const info = scope === ME ? null : await this.ws.readJSON(scope, '/trip.json').catch(() => null);
    if (info?.simulation === true) this.#still.add(scope);
    else this.#still.delete(scope);
    if (this.#still.has(scope) && this.#sim?.trip !== scope) {
      this.#watches.delete(scope);
      return;
    }
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
    const sim = await this.ws.readJSON(trip, '/trip.json').catch(() => null);
    if (sim?.simulation === true) this.#still.add(trip);
    else this.#still.delete(trip);
    if (!this.#inPlay(trip)) return; // a simulation's plan reminds only during its run (review 4)
    // An archived trip, open or not, reminds of nothing: its watches aren't loaded either (#loadAll).
    if ((await this.store.tx(['scopes'], 'readonly', (t) => t.getScope(trip)))?.status === 'archived') return;
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
    this.#prune();
  }

  /** Forgets the memories and firings of watches that are gone: hers that fired or were cancelled, plan items no longer planned, other trips' plans. */
  #prune() {
    const keep = new Set(this.#plan.map((w) => this.#key(this.#scope(), w.id)));
    for (const [scope, list] of this.#watches) for (const w of list) keep.add(this.#key(scope, w.id));
    for (const map of [this.#mem, this.#fired]) for (const k of [...map.keys()]) if (!keep.has(k)) map.delete(k);
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

  /**
   * One check of one watch. A bug in a plugin's trigger counts against its plugin (spec §5.5); a
   * plain error is the trigger saying it can't tell yet, noted once in the conversation's log.
   * @param {TriggerType} type @param {Watch} w @param {string} scope @param {Moment} m
   */
  #try(type, w, scope, m) {
    const mem = this.#memFor(type, w, scope, m);
    try {
      return type.check(w.when, m, mem) ?? null;
    } catch (e) {
      if (type.pluginId && isPluginBug(e)) this.registry.fail(type.pluginId, `trigger ${type.type}`, e);
      else this.#noteOnce(scope, `The ${type.type} watch ${w.id} can't be checked: ${String(/** @type {any} */ (e)?.message ?? e).replace(/[.!?]$/, '')}.`);
      return null;
    }
  }

  /** Notes a problem in a conversation's log, once. @param {string} scope @param {string} message */
  #noteOnce(scope, message) {
    const key = `${scope}\n${message}`;
    if (this.#noted.has(key)) return;
    this.#noted.add(key);
    this.#bg(async () => {
      if (await this.#exists(scope)) await logEvent(this.store, scope, { type: 'error', actor: 'system', data: { kind: 'trigger', message } });
    });
  }

  /** Whether a watch is looked at now: its conversation's, live mode for GPS, and time watches anywhere (choices 2 and 3). @param {TriggerType | undefined} type @param {string} scope */
  #looked(type, scope) {
    return Boolean(type) && this.#inPlay(scope) && !(type?.gps && !this.on) && (scope === this.#scope() || type?.type === 'time');
  }

  /** Looks at every watch now (spec §11.3), fires what is due as one wake, and sets the clock for the next. @param {{ newFix?: boolean, change?: { from: string, to: string } | null, past?: boolean }} [o] */
  async #check(o = {}) {
    if (this.#elsewhere()) return;
    await this.#follow();
    const m = this.#moment(o);
    const open = this.#scope();
    /** @type {Fired[]} */
    const fired = [];
    try {
      await this.#look(m, open, fired);
    } finally {
      this.#schedule(m); // whatever failed, the clock goes on (L1)
    }
    // Most checks only move a time a little (a new fix): calm. One that said a reminder: urgent (6b choice 3).
    this.#tellReminders(fired.length ? 'urgent' : 'calm');
  }

  /** The watches and the plan looked at (#check), and what fired fired. @param {Moment} m @param {string} open @param {Fired[]} fired */
  async #look(m, open, fired) {
    const types = this.types();
    for (const [scope, list] of [...this.#watches]) {
      if (!this.#inPlay(scope)) continue; // the user's own watches aren't due, or expired, on a simulation's clock (review 1)
      for (const w of [...list]) {
        if (expired(w, m.now)) {
          await this.#drop(scope, w).catch((e) => this.#fail(e)); // gone from live mode, if not from its file
          continue;
        }
        const type = types.get(w.when?.type);
        if (!type || !this.#looked(type, scope) || this.#broken(type, w)) continue; // a broken watch never fires; watch_list says why
        const f = this.#try(type, w, scope, m);
        if (f) fired.push(this.#firedOf(scope, w, type, f, m.now));
      }
    }
    for (const w of this.#plan) {
      if (!w.repeat && this.#spent(open, w)) continue;
      const f = this.#try(PLAN, w, open, m);
      if (f) fired.push(this.#firedOf(open, w, PLAN, f, m.now));
    }
    if (fired.length) await this.#fire(fired, m.now);
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
      const f = { ...x.firing, place: this.#stampPlace(x.watch, x.firing.place) };
      // An arrival names its zone, so its stamp's day is the day where it was earned (spec §13): the plan item's, else the phone's.
      const when = /** @type {any} */ (x.watch.when);
      const tz = isArrival({ type: when?.type, event: when?.event }) ? (validZone(when?.tz) ? when.tz : this.timeZone()) : null;
      // A firing the log can't take still fires, once: it is told, never tried again at every check.
      await logEvent(this.store, x.scope, {
        type: 'trigger.fired', actor: 'system',
        data: {
          watch: x.watch.id, type: x.watch.when.type, ...(x.watch.when.event ? { event: x.watch.when.event } : {}), ...(forAt(x.watch) !== null ? { for: forAt(x.watch) } : {}), owner: x.watch.owner, text: f.text, fallback: x.fallback,
          ...(x.late ? { late: x.late } : {}), ...(f.place ? { place: f.place } : {}), ...(tz ? { tz } : {}), ...(this.#catch ? { catchUp: true } : {}), ...(this.online ? {} : { offline: true }),
        },
      }, now).catch((e) => this.#fail(e));
      this.#fired.set(key, { at: now, place: f.place ?? null, ...(forAt(x.watch) !== null ? { for: /** @type {number} */ (forAt(x.watch)) } : {}) });
      const mem = this.#mem.get(key);
      if (mem) {
        mem.lastAt = now;
        mem.km0 = this.odometer;
        if (f.place) mem.lastPlace = f.place;
      }
      done.push(x);
      // A one-time watch goes; a watch file that can't be removed is told, and the reminder still comes (L1).
      if (x.watch.owner !== 'system' && (x.watch.when.type === 'time' || (!x.watch.repeat && x.watch.when.type !== 'every'))) await this.#drop(x.scope, x.watch).catch((e) => this.#fail(e));
      // Said on screen, now or in the catch-up: a notification for it from now on is a double (one shown while away was read first).
      if (this.shown) {
        this.#said.add(this.#keyOf(x.scope, x.watch));
        if (this.#said.size > 200) this.#said.delete(/** @type {string} */ (this.#said.values().next().value));
      }
    }
    if (this.#catch) this.#catch.fired.push(...done);
    else if (done.length) await this.#deliver(done);
  }

  /**
   * Wakes Shiori for what fired. In another conversation (a time watch of a trip that isn't open):
   * its reminders now, and the wake written into it for when it opens (choice 3).
   * @param {Fired[]} list @param {'trigger' | 'catch-up'} [kind] @param {string} [header]
   * @param {{ scope: string, text: string }[]} [opened] notifications the user opened (spec §11.6)
   */
  async #deliver(list, kind = 'trigger', header = '', opened = []) {
    const open = this.#scope();
    /** @type {Map<string, Fired[]>} */
    const by = new Map();
    for (const x of list) by.set(x.scope, [...(by.get(x.scope) ?? []), x]);
    /** @type {Map<string, string[]>} */
    const notes = new Map();
    for (const o of opened) notes.set(o.scope, [...(notes.get(o.scope) ?? []), o.text]);
    for (const scope of notes.keys()) if (!by.has(scope)) by.set(scope, []);
    for (const [scope, xs] of by) {
      const reasons = xs.map((x) => this.#reason(x));
      const fallbacks = xs.map((x) => ({ watch: x.watch.id, text: x.fallback }));
      const lines = notes.get(scope) ?? [];
      if (scope !== open) {
        if (fallbacks.length) await this.agent.remind(fallbacks, scope);
        await this.agent.wake({ kind, text: [...lines, ...reasons].join(' '), scope });
        continue;
      }
      const text = [header, ...lines, ...reasons].filter(Boolean).join(' ');
      if (!this.online) {
        // No connection: annai says the reminders itself now; Shiori hears of them when it is back (spec §17, choice 8).
        if (fallbacks.length) await this.agent.remind(fallbacks);
        this.#held.push({ scope, text });
        continue;
      }
      await this.agent.wake({ kind, text, fallbacks });
    }
  }

  /** What fired, in words for Shiori's wake; with when its notification was shown, if it was (spec §11.6). @param {Fired} x */
  #reason(x) {
    const key = this.#keyOf(x.scope, x.watch);
    const shown = this.#notified.get(key);
    this.#notified.delete(key);
    const notes = [
      x.late ? `late by ${x.late} min: annai was ${x.away === 'start' ? 'closed' : 'off screen'}` : '',
      shown !== undefined ? `its notification was shown at ${timeIn(shown, this.timeZone())}` : '',
    ].filter(Boolean);
    const late = notes.length ? ` (${notes.join('; ')})` : '';
    if (x.watch.owner === 'system') return `${x.firing.text}${late}.`;
    const whose = x.watch.owner === 'shiori' ? 'Your watch' : `The watch of ${x.watch.owner}`;
    return `${whose} ${x.watch.id} (${this.#describe(x.type, x.watch)}) fired: ${x.firing.text}${late}. Its reminder: "${x.watch.fallback}"`;
  }

  /**
   * An arrival's place, named when it is at a plan place or a place a namer knows, so its stamp
   * comes from the log alone (spec §13, choice 1). Other places are as they came.
   * @param {Watch} w @param {import('./triggers.js').Place | undefined} p
   */
  #stampPlace(w, p) {
    if (!p || p.name || !isArrival({ type: w.when?.type, event: /** @type {any} */ (w.when)?.event })) return p;
    /** @type {{ name: string, m: number } | null} */
    let best = null;
    for (const q of this.#places) {
      const d = meters(p, q);
      if (d <= STAMP_PLAN_M && (!best || d < best.m)) best = { name: q.name, m: d };
    }
    if (!best) {
      for (const n of this.namers) {
        try {
          const r = n(p);
          if (r && r.m <= STAMP_POI_M && (!best || r.m < best.m)) best = r;
        } catch {
          // a namer that fails names nothing
        }
      }
    }
    return best ? { name: best.name, ...p } : p;
  }

  /** @param {string} scope */
  async #exists(scope) {
    return scope === ME || Boolean(await this.store.tx(['scopes'], 'readonly', (t) => t.getScope(scope)));
  }

  /**
   * Whether a one-time watch has fired. The plan's leave, late and coming-up reminders are spent only
   * for the time they fired for: an item moved later gets them again; arriving stays arrived.
   * @param {string} scope @param {Watch} w
   */
  #spent(scope, w) {
    const f = this.#fired.get(this.#key(scope, w.id));
    if (!f) return false;
    const at = forAt(w);
    return at === null || f.for === undefined || f.for === at;
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
    this.#tellReminders('urgent');
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
      if (!this.#inPlay(scope)) continue;
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
      if (mem && (w.repeat || !this.#spent(open, w))) consider(PLAN.next?.(w.when, m, mem));
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

/** For the plan's reminders bound to an item's time (leave, late, coming up): that time; else null. @param {Watch} w @returns {number | null} */
function forAt(w) {
  const when = /** @type {any} */ (w.when);
  return when?.type === 'plan' && ['leave', 'late', 'coming-up'].includes(when.event) && typeof when.at === 'number' ? when.at : null;
}

/** A location point as the log keeps it (spec §4.5). @param {Fix} f */
function pointData(f) {
  return {
    lat: round6(f.lat), lng: round6(f.lng), accuracy: Math.round(f.accuracy),
    ...(f.speed !== null ? { speed: Math.round(f.speed * 10) / 10 } : {}), ...(f.heading !== null ? { heading: Math.round(f.heading) } : {}),
    ...(f.source !== 'gps' ? { source: f.source } : {}),
  };
}
