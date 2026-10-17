import { h } from './dom.js';

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
    toast: (/** @type {string} */ text) => ctx.notices.toast(String(text)),
    card: (/** @type {any} */ c) => ctx.notices.card({ title: String(c?.title ?? ''), body: c?.body === undefined ? undefined : String(c.body), tone: c?.tone, actions: c?.actions }),
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

/**
 * Runs a plugin's drawing into el. A cleanup it returns (a function, or a promise of one) runs when
 * that group is drawn again; anything it throws, or a promise of it that rejects, is its plugin's
 * failure (counted), and el is left empty and hidden.
 * @param {any} ctx @param {Entry} entry @param {HTMLElement} el @param {(ui: any) => any} call
 * @param {{ group?: 'screen' | 'dock', what?: string }} [o]
 */
export function mount(ctx, entry, el, call, { group = 'screen', what = 'drawing' } = {}) {
  const fail = (/** @type {unknown} */ e) => {
    el.replaceChildren();
    el.hidden = true;
    ctx.registry?.fail(entry.pluginId, what, e);
  };
  try {
    const r = call(pluginUi(ctx, entry.pluginId));
    if (r && typeof r.then === 'function') {
      r.then((/** @type {unknown} */ x) => { if (typeof x === 'function') cleanups[group].push(/** @type {() => void} */ (x)); }, fail);
    } else if (typeof r === 'function') {
      cleanups[group].push(r);
    }
  } catch (e) {
    fail(e);
  }
}

/** Runs and forgets the cleanups of what was drawn on the screen or the dock. @param {'screen' | 'dock'} group */
export function cleanUp(group) {
  for (const fn of cleanups[group].splice(0)) {
    try {
      fn();
    } catch {
      // a cleanup that fails changes nothing more
    }
  }
}

/** The running plugins' items of a kind ("ui:status-chip"), in the order they came. @param {any} ctx @param {string} kind @returns {Entry[]} */
export function slotEntries(ctx, kind) {
  return ctx.registry?.entries(kind) ?? [];
}

/** The replacement for a named component (the last one registered wins), or null (choice 4). @param {any} ctx @param {string} name @returns {Entry | null} */
export function component(ctx, name) {
  const list = slotEntries(ctx, 'ui:component').filter((e) => e.item?.name === name);
  return list[list.length - 1] ?? null;
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
