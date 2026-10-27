import { h, otherLang } from './dom.js';

/**
 * What plugins add to annai's screens (spec §16.4), drawn. Each item draws itself into an element
 * annai made, with the ui object below (choice 8 of milestone 8b); what throws counts against its
 * plugin and never breaks the screen (choice 3).
 * @typedef {{ pluginId: string, item: any }} Entry
 */

const UI_KINDS = ['ui:status-chip', 'ui:now-section', 'ui:dock-action', 'ui:trip-tab', 'ui:settings-page', 'ui:card-type', 'ui:component', 'ui:screen', 'ui:theme'];

/** @type {WeakMap<object, number>} */
const serials = new WeakMap();
let next = 0;
/** A number for each contribution, so one registered again (a plugin started again) counts as new. @param {any} item */
const serial = (item) => {
  if (!item || typeof item !== 'object') return 0;
  if (!serials.has(item)) serials.set(item, ++next);
  return serials.get(item);
};

/** What plugins add to the UI now, as one string: it changes only when that does. @param {import('../core/registry.js').Registry} registry */
export function uiSignature(registry) {
  return JSON.stringify(UI_KINDS.map((k) => registry.entries(k).map((e) => [e.pluginId, serial(e.item)])));
}

/**
 * The object a plugin's drawing gets: annai's DOM builder, where to go, the open trip, system
 * cards and toasts, Shiori and live mode (choice 8).
 * @param {any} ctx @param {string} pluginId
 */
export function pluginUi(ctx, pluginId) {
  const on = (/** @type {string} */ kind, /** @type {(x: any) => void} */ fn) => {
    try {
      return ctx.agent?.on(kind, fn) ?? (() => {});
    } catch {
      return () => {};
    }
  };
  return Object.freeze({
    plugin: pluginId,
    h,
    go: (/** @type {string} */ hash) => ctx.go(String(hash)),
    trip: () => ctx.agent?.trip ?? null,
    toast: (/** @type {string} */ text) => ctx.notices.toast(String(text), { lang: ctx.plugins?.langOf(pluginId) }),
    card: (/** @type {any} */ c) => ctx.notices.card({ title: String(c?.title ?? ''), body: c?.body === undefined ? undefined : String(c.body), tone: c?.tone, actions: c?.actions, lang: ctx.plugins?.langOf(pluginId) }),
    shiori: Object.freeze({
      state: () => ({ ...(ctx.agent?.state ?? { name: 'sleeping', label: '' }) }),
      on,
      tap: () => ctx.agent?.tap(),
      send: (/** @type {string} */ text) => ctx.agent?.send(String(text)),
    }),
    live: Object.freeze({
      on: () => Boolean(ctx.live?.on),
      activity: () => String(ctx.live?.activity ?? 'unknown'),
      onChange: (/** @type {() => void} */ fn) => ctx.live?.onChange(fn) ?? (() => {}),
    }),
  });
}

/** @type {Record<'screen' | 'dock', (() => void)[]>} cleanups plugins' drawings returned, by what they were drawn on */
const cleanups = { screen: [], dock: [] };
/** The shell's render whose drawings are the screen's now (minors 15). */
let shown = 0;

/** Runs a cleanup; one that fails changes nothing more. @param {() => void} fn */
const run = (fn) => {
  try {
    fn();
  } catch {
    // a cleanup that fails changes nothing more
  }
};

/**
 * Runs a plugin's drawing into el. A cleanup it returns (a function, or a promise of one) runs when
 * that group is drawn again, or at once when it comes from a render the shell gave up on (ctx.seq,
 * minors 15); anything it throws, or a promise of it that rejects, is its plugin's
 * failure (counted), el is left empty and hidden, and onFail runs, so annai can draw its own instead
 * (fix pass 8b-3). A drawing that returns, or whose promise resolves, ends its plugin's run of failures
 * (fix pass 8b-4). Returns false when it failed at once.
 * @param {any} ctx @param {Entry} entry @param {HTMLElement} el @param {(ui: any) => any} call
 * @param {{ group?: 'screen' | 'dock', what?: string, onFail?: () => void }} [o]
 */
export function mount(ctx, entry, el, call, { group = 'screen', what = 'drawing', onFail } = {}) {
  const seq = group === 'screen' ? ctx.seq : undefined;
  const keep = (/** @type {unknown} */ x) => {
    if (typeof x !== 'function') return;
    if (seq !== undefined && seq !== shown) run(/** @type {() => void} */ (x));
    else cleanups[group].push(/** @type {() => void} */ (x));
  };
  // Its words' language, when it isn't the screens' (localization design, section 8).
  const words = otherLang(ctx.plugins?.langOf(entry.pluginId));
  if (words) el.lang = words;
  let failed = false;
  const fail = (/** @type {unknown} */ e) => {
    if (failed) return;
    failed = true;
    el.replaceChildren();
    el.hidden = true;
    ctx.registry?.fail(entry.pluginId, what, e);
    onFail?.();
  };
  const worked = () => ctx.registry?.succeeded(entry.pluginId);
  try {
    const r = call(pluginUi(ctx, entry.pluginId));
    if (r && typeof r.then === 'function') {
      r.then((/** @type {unknown} */ x) => {
        keep(x);
        worked();
      }, fail);
    } else {
      keep(r);
      worked();
    }
  } catch (e) {
    fail(e);
  }
  return !failed;
}

/**
 * Runs a plugin's dock action (spec §16.4: dock-action). What it throws, or a promise of it that rejects,
 * is its plugin's failure; a run that returns, or whose promise resolves, ends its run of failures (fix pass 8b-4).
 * @param {any} ctx @param {Entry} entry
 */
export function runAction(ctx, entry) {
  const fail = (/** @type {unknown} */ e) => ctx.registry?.fail(entry.pluginId, /* en */ `dock action ${entry.item.id}`, e);
  try {
    const worked = () => ctx.registry?.succeeded(entry.pluginId);
    const r = entry.item.run(pluginUi(ctx, entry.pluginId));
    if (r && typeof r.then === 'function') r.then(worked, fail);
    else worked();
  } catch (e) {
    fail(e);
  }
}

/**
 * A component a plugin makes (an avatar or a dock, spec §16.4): what create() returns when wrong(it) has
 * nothing to say, which ends its plugin's run of failures (fix pass 8b-4); else null, and its plugin's
 * failure is counted.
 * @template T
 * @param {any} ctx @param {Entry} entry @param {string} what @param {() => T} create @param {(made: T) => string | null} wrong
 * @returns {T | null}
 */
export function made(ctx, entry, what, create, wrong) {
  try {
    const x = create();
    const why = wrong(x);
    if (why) throw new Error(why);
    ctx.registry?.succeeded(entry.pluginId);
    return x;
  } catch (e) {
    ctx.registry?.fail(entry.pluginId, what, e);
    return null;
  }
}

/**
 * Runs and forgets the cleanups of what was drawn on the screen or the dock. seq: the shell's render
 * that draws the screen from now on; what an earlier one draws later is cleaned up as it comes.
 * @param {'screen' | 'dock'} group @param {number} [seq]
 */
export function cleanUp(group, seq) {
  if (group === 'screen' && seq !== undefined) shown = seq;
  cleanups[group].splice(0).forEach(run);
}

/** The running plugins' items of a kind ("ui:status-chip"), in the order they came. @param {any} ctx @param {string} kind @returns {Entry[]} */
export function slotEntries(ctx, kind) {
  return ctx.registry?.entries(kind) ?? [];
}

/** A plugin's replacement for a named component, when it owns the name (the user chose it), or null: annai's own. @param {any} ctx @param {string} name @returns {Entry | null} */
export function component(ctx, name) {
  return slotEntries(ctx, 'ui:component').find((e) => e.item?.name === name) ?? null;
}

/** Which plugins' dock and avatar replace annai's now: when it changes, the dock is made again (choice 9). @param {any} ctx */
export function dockKey(ctx) {
  return JSON.stringify(['dock', 'avatar'].map((n) => {
    const c = component(ctx, n);
    return c ? [c.pluginId, serial(c.item)] : null;
  }));
}

/** One stylesheet link per plugin theme, added and removed as they come and go (choice 6). @param {import('../core/registry.js').Registry} registry @param {HTMLElement} head */
export function syncThemes(registry, head) {
  const want = new Map(registry.entries('ui:theme').map((e) => [`${e.pluginId}|${e.item.href}`, e.item.href]));
  for (const l of [...head.querySelectorAll('link[data-plugin-theme]')]) {
    const key = /** @type {HTMLLinkElement} */ (l).dataset.pluginTheme ?? '';
    if (want.has(key)) want.delete(key);
    else l.remove();
  }
  for (const [key, href] of want) head.append(h('link', { rel: 'stylesheet', href, dataset: { pluginTheme: key } }));
}
