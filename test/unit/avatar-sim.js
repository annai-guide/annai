// A stub page for driving the real src/ui/avatar.js on a virtual clock, after the post-release review's harness: elements
// that know whether they are on the page, timers and animation frames that run only when the test moves time on, one
// reduced-motion media query that can change, an IntersectionObserver the test tells what is on screen, and getBBox.
// Import it before anything else in a test file: it sets the globals avatar.js finds when it loads.

const env = /** @type {any} */ (globalThis);
let reduced = false;
/** @type {Set<(e: any) => void>} */
const motionListeners = new Set();
const motion = {
  get matches() { return reduced; },
  addEventListener: (/** @type {string} */ _t, /** @type {(e: any) => void} */ fn) => motionListeners.add(fn),
  removeEventListener: (/** @type {string} */ _t, /** @type {(e: any) => void} */ fn) => motionListeners.delete(fn),
};
export const counts = { matchMedia: 0, frames: 0 };
env.matchMedia = () => {
  counts.matchMedia++;
  return motion;
};
/** Turns the reduced-motion preference on or off, as the system setting would. @param {boolean} on */
export function setReduced(on) {
  reduced = on;
  for (const fn of [...motionListeners]) fn({ matches: on });
}
/** How many reduced-motion listeners are attached: none once every avatar is off the page. */
export const motionListenerCount = () => motionListeners.size;

/** Whether the art file has arrived: parts measure 0 wide until it has. */
export const art = { loaded: true };

/** @type {Set<Observer>} */
const observers = new Set();
class Observer {
  /** @param {(entries: any[]) => void} fn */
  constructor(fn) {
    this.fn = fn;
    /** @type {Set<El>} */
    this.targets = new Set();
    observers.add(this);
  }
  /** As a browser does, it reports a newly watched element's state at the next frame. @param {El} el */
  observe(el) {
    this.targets.add(el);
    setTimeout(() => this.report(el), 0);
  }
  /** @param {El} el */
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  /** @param {El} el */
  report(el) {
    if (this.targets.has(el)) this.fn([{ target: el, isIntersecting: el.isConnected && el.onScreen, boundingClientRect: { width: 64 } }]);
  }
}
env.IntersectionObserver = Observer;

class El {
  /** @param {string} tag */
  constructor(tag) {
    this.tag = tag;
    /** @type {Record<string, string>} */
    this.attrs = {};
    /** @type {El[]} */
    this.children = [];
    /** @type {El | null} */
    this.parent = null;
    this.connected = false;
    this.onScreen = true;
    /** Writes, by attribute or property name, to watch what the avatar touches. */
    /** @type {Record<string, number>} */
    this.writes = {};
    const count = (/** @type {string} */ k) => { this.writes[k] = (this.writes[k] ?? 0) + 1; };
    /** @type {Record<string, string>} */
    const data = {};
    this.dataset = new Proxy(data, {
      set(t, k, v) { if (typeof k === 'string') { count(`data-${k}`); t[k] = v; } return true; },
      deleteProperty(t, k) { if (typeof k === 'string') { count(`data-${k}`); delete t[k]; } return true; },
    });
    /** @type {Record<string, string>} */
    const props = {};
    this.style = new Proxy(props, {
      get(t, k) {
        if (k === 'setProperty') return (/** @type {string} */ p, /** @type {string} */ v) => { count(p); t[p] = v; };
        if (k === 'removeProperty') return (/** @type {string} */ p) => { delete t[p]; };
        return typeof k === 'string' ? t[k] ?? '' : undefined;
      },
      set(t, k, v) { if (typeof k === 'string') { count(k); t[k] = v; } return true; },
    });
  }
  /** @param {string} k @param {any} v */
  setAttribute(k, v) {
    this.writes[k] = (this.writes[k] ?? 0) + 1;
    this.attrs[k] = String(v);
  }
  /** @param {string} k */
  getAttribute(k) { return this.attrs[k] ?? null; }
  /** @param {...El} cs */
  append(...cs) {
    for (const c of cs) {
      c.parent = this;
      this.children.push(c);
    }
  }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class ?? ''; }
  set textContent(v) { this.text = v; }
  get textContent() { return this.text ?? ''; }
  addEventListener() {}
  get isConnected() {
    /** @type {El} */
    let n = this;
    while (n.parent) n = n.parent;
    return n.connected;
  }
  /** The first descendant with this class. @param {string} cls @returns {El | null} */
  find(cls) {
    for (const c of this.children) {
      if ((c.attrs.class ?? '').split(' ').includes(cls)) return c;
      const f = c.find(cls);
      if (f) return f;
    }
    return null;
  }
  getBBox() { return art.loaded && this.isConnected ? { x: 0, y: 0, width: 300, height: 300 } : { x: 0, y: 0, width: 0, height: 0 }; }
}
env.Node = El;
env.document = {
  createElement: (/** @type {string} */ t) => new El(t),
  createElementNS: (/** @type {string} */ _ns, /** @type {string} */ t) => new El(t),
  createTextNode: (/** @type {string} */ t) => Object.assign(new El('#text'), { text: t }),
};

let now = 0;
/** @type {{ id: number, at: number, fn: () => void }[]} */
let timers = [];
let lastTimer = 0;
/** @type {{ id: number, fn: (t: number) => void }[]} */
let frames = [];
let lastFrame = 0;
env.performance = { now: () => now };
env.setTimeout = (/** @type {() => void} */ fn, /** @type {number} */ ms = 0) => {
  timers.push({ id: ++lastTimer, at: now + ms, fn });
  return lastTimer;
};
env.clearTimeout = (/** @type {number} */ id) => { timers = timers.filter((t) => t.id !== id); };
env.requestAnimationFrame = (/** @type {(t: number) => void} */ fn) => {
  frames.push({ id: ++lastFrame, fn });
  return lastFrame;
};
env.cancelAnimationFrame = (/** @type {number} */ id) => { frames = frames.filter((r) => r.id !== id); };
/** Moves time on by ms, running due timers and an animation frame every 1/60 s. @param {number} ms */
export function advance(ms, step = 1000 / 60) {
  const end = now + ms;
  while (now < end - 1e-9) {
    const next = Math.min(end, now + step);
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!timers.length || timers[0].at > next) break;
      const t = /** @type {{ id: number, at: number, fn: () => void }} */ (timers.shift());
      now = t.at;
      t.fn();
    }
    now = next;
    const batch = frames;
    frames = [];
    for (const r of batch) {
      counts.frames++;
      r.fn(now);
    }
  }
}
/** Timers and animation frames still waiting. */
export const pending = () => timers.length + frames.length;
Math.random = () => 1; // blinks every 7.8 s, out of the way of short scenarios

export const { createAvatar } = await import('../../src/ui/avatar.js');

/**
 * An avatar, put on the page (or not), as the dock size.
 * @param {boolean} [onPage]
 */
export function make(onPage = true) {
  const a = createAvatar({ size: 'dock' });
  place(a, onPage);
  return a;
}
/**
 * Puts an avatar on the page or takes it off, and on screen or off it; the observer reports the change.
 * @param {any} a @param {boolean} onPage @param {boolean} [onScreen]
 */
export function place(a, onPage, onScreen = true) {
  a.el.connected = onPage;
  a.el.onScreen = onScreen;
  for (const o of observers) o.report(a.el);
}
/** @param {any} a */
export const av = (a) => /** @type {El} */ (a.el.find('av'));
/** Her front eyes. @param {any} a */
export const frontEyes = (a) => /** @type {El} */ (/** @type {El} */ (a.el.find('head')).children.find((c) => c.attrs.class === 'eyes'));
/** The front eyes' highlight width: 14.5 open, 17.4 wide, 0 closed or asleep. @param {any} a */
export const frontLight = (a) => /** @type {El} */ (frontEyes(a).find('light')).getAttribute('rx');
/** The marker's streamer path. @param {any} a */
export const markerBand = (a) => /** @type {El} */ (/** @type {El} */ (a.el.find('marker')).find('band'));
