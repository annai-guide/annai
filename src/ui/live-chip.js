import { h, t } from './dom.js';
import { sentences } from './format.js';
import { PLAN_FILE } from '../core/plan.js';
import { FRESH_MS } from '../core/live/live.js';

/**
 * Where the user is, when annai knows: a place they said, or a GPS position that is current. One from
 * before the GPS was lost (refused, a tunnel) or older than ten minutes isn't where they are now, by
 * live mode's own clock: a simulation's, while one runs (spec §13).
 * @param {{ on: boolean, gps: string, fix: any, clock?: { now: () => number } }} live @param {number} [now]
 */
export function knownFix(live, now = live.clock?.now() ?? Date.now()) {
  const f = live.fix;
  if (!live.on || !f) return null;
  return f.source === 'manual' || (live.gps === 'ok' && now - f.at <= FRESH_MS) ? f : null;
}

/** The GPS chip's words; during a simulation, it says so (7b choice 10). @param {{ on: boolean, gps: string, activity: string, fix: any, simulating?: boolean, clock?: { now: () => number } }} live */
export function liveText(live) {
  /** @type {Record<string, string>} */
  const doing = live.simulating
    ? { 'moving-fast': t`Simulation · moving fast`, walking: t`Simulation · walking`, still: t`Simulation · stopped` }
    : { 'moving-fast': t`GPS on · moving fast`, walking: t`GPS on · walking`, still: t`GPS on · stopped` };
  if (live.simulating) return doing[live.activity] ?? t`Simulation · on`;
  if (!live.on) return t`GPS off`;
  if (!knownFix(live)) return live.gps === 'denied' ? t`GPS on · no location` : live.gps === 'unavailable' ? t`GPS on · no signal` : t`GPS on · finding you`;
  return doing[live.activity] ?? t`GPS on`;
}

/**
 * "Keep the screen on while driving or riding", and what a choice of it says, as whole sentences for the activity.
 * @param {string} activity @returns {{ keep: string, stays: string, goes: string }}
 */
export function screenOn(activity) {
  if (activity === 'moving-fast') return { keep: t`Keep the screen on while driving or riding`, stays: t`The screen stays on while driving or riding.`, goes: t`The screen goes off as usual while driving or riding.` };
  if (activity === 'walking') return { keep: t`Keep the screen on while walking`, stays: t`The screen stays on while walking.`, goes: t`The screen goes off as usual while walking.` };
  if (activity === 'still') return { keep: t`Keep the screen on while stopped`, stays: t`The screen stays on while stopped.`, goes: t`The screen goes off as usual while stopped.` };
  return { keep: t`Keep the screen on while GPS is on`, stays: t`The screen stays on while GPS is on.`, goes: t`The screen goes off as usual while GPS is on.` };
}

/**
 * The live chip (spec §11.1: live mode is a switch), one tap away on every screen next to the voice
 * chip. A tap shows the switch; with live mode on, "Keep the screen on" for this situation; and with
 * no GPS, "Where are you?", the trip's plan places (§17: "a manual place").
 * @param {any} ctx
 */
export function liveChip(ctx) {
  const live = ctx.live;
  const chip = h('button', { class: 'chip live-chip', type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'true', 'aria-controls': 'live-menu' });
  const menu = h('div', { id: 'live-menu', class: 'voice-menu live-menu', role: 'group', 'aria-label': /* en */ 'GPS', hidden: true });
  /** Open, or opening: a second tap while it reads the plan's places closes it, rather than opening it again. */
  let shown = false;
  let opens = 0;
  /** A tap anywhere else closes it. @param {Event} e */
  const outside = (e) => { if (!el.contains(/** @type {Node} */ (e.target))) close(); };
  const close = () => {
    shown = false;
    opens++;
    menu.hidden = true;
    menu.replaceChildren();
    chip.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  /** @param {Node[]} items */
  const showItems = (items) => {
    menu.replaceChildren(...items);
    menu.hidden = false;
  };
  const open = async () => {
    shown = true;
    const mine = ++opens;
    chip.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    const sim = ctx.sim;
    if (sim?.running) {
      // A simulation has live mode: the chip pauses or stops it (7b choice 10).
      showItems([
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); if (sim.state?.paused) sim.resume(); else sim.pause(); } }, sim.state?.paused ? t`Resume the simulation` : t`Pause the simulation`),
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); sim.stop(); } }, t`Stop the simulation`),
        h('a', { class: 'btn', href: '#/simulate', onclick: () => close() }, t`Simulate a trip`)]);
      return;
    }
    const items = [h('button', {
      class: 'btn', type: 'button', 'aria-pressed': String(live.on),
      onclick: async () => {
        close();
        await live.setLive(!live.on);
      },
    }, live.on ? t`Turn GPS off` : t`Turn GPS on`)];
    const awake = ctx.awake;
    if (live.on && awake?.available) {
      items.push(h('button', {
        class: 'btn', type: 'button', 'aria-pressed': String(awake.chosen),
        onclick: async () => {
          close();
          const on = !awake.chosen;
          await awake.choose(on);
          ctx.notices.toast(on ? screenOn(live.activity).stays : screenOn(live.activity).goes);
        },
      }, screenOn(live.activity).keep));
    }
    if (live.on && (live.gps === 'denied' || live.gps === 'unavailable')) {
      const places = await planPlaces(ctx);
      items.push(h('p', { class: 'sub', text: places.length ? t`Where are you?` : sentences(t`Where are you?`, t`The plan has no places to choose from yet.`) }));
      for (const p of places) {
        items.push(h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            close();
            await live.place(p);
            ctx.notices.toast(t`annai now knows you're at ${p.name}.`);
          },
        }, p.name));
      }
    }
    if (mine === opens) showItems(items); // else it was closed while the places were read
  };
  chip.addEventListener('click', () => { if (shown) close(); else open(); });

  const show = () => {
    chip.textContent = liveText(live);
    chip.classList.toggle('on', live.on);
  };
  const offs = [live.onChange(show), ctx.sim?.onChange(show)];
  show();
  const el = h('div', { class: 'voice-chip-wrap' }, chip, menu);
  // Escape closes it, from the chip or from inside the menu.
  el.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    close();
    chip.focus();
  });
  // dispose: the dock is remade; an open menu's listener for a tap elsewhere goes with it, and so do its own.
  return { el, dispose: () => { close(); offs.forEach((off) => off?.()); } };
}

/** The open trip's plan places, for "Where are you?". @param {any} ctx @returns {Promise<{ name: string, lat: number, lng: number }[]>} */
async function planPlaces(ctx) {
  const trip = ctx.agent?.trip;
  if (!trip) return [];
  /** @type {{ name: string, lat: number, lng: number }[]} */
  const out = [];
  for (const f of await ctx.ws.list(trip, '/plan/')) {
    if (!PLAN_FILE.test(f.path)) continue;
    const it = await ctx.ws.readJSON(trip, f.path).catch(() => null);
    const p = it?.place;
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
    const name = String(p.name ?? it.title ?? t`A plan place`);
    if (!out.some((x) => x.name === name)) out.push({ name, lat: p.lat, lng: p.lng });
  }
  return out.slice(0, 8);
}
