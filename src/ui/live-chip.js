import { h } from './dom.js';
import { PLAN_FILE } from '../core/plan.js';
import { FRESH_MS } from '../core/live/live.js';

const DOING = /** @type {Record<string, string>} */ ({ 'moving-fast': 'moving fast', walking: 'walking', still: 'stopped' });

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
  if (live.simulating) return `Simulation · ${DOING[live.activity] ?? 'on'}`;
  if (!live.on) return 'GPS off';
  if (!knownFix(live)) return live.gps === 'denied' ? 'GPS on · no location' : live.gps === 'unavailable' ? 'GPS on · no signal' : 'GPS on · finding you';
  return DOING[live.activity] ? `GPS on · ${DOING[live.activity]}` : 'GPS on';
}

/** "Keep the screen on while driving or riding". @param {string} activity */
export function whileText(activity) {
  return /** @type {Record<string, string>} */ ({ 'moving-fast': 'while driving or riding', walking: 'while walking', still: 'while stopped' })[activity] ?? 'while GPS is on';
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
  const menu = h('div', { id: 'live-menu', class: 'voice-menu live-menu', role: 'group', 'aria-label': 'GPS', hidden: true });
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
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); if (sim.state?.paused) sim.resume(); else sim.pause(); } }, sim.state?.paused ? 'Resume the simulation' : 'Pause the simulation'),
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); sim.stop(); } }, 'Stop the simulation'),
        h('a', { class: 'btn', href: '#/simulate', onclick: () => close() }, 'Simulate a trip')]);
      return;
    }
    const items = [h('button', {
      class: 'btn', type: 'button', 'aria-pressed': String(live.on),
      onclick: async () => {
        close();
        await live.setLive(!live.on);
      },
    }, live.on ? 'Turn GPS off' : 'Turn GPS on')];
    const awake = ctx.awake;
    if (live.on && awake?.available) {
      items.push(h('button', {
        class: 'btn', type: 'button', 'aria-pressed': String(awake.chosen),
        onclick: async () => {
          close();
          const on = !awake.chosen;
          await awake.choose(on);
          ctx.notices.toast(on ? `The screen stays on ${whileText(live.activity)}.` : `The screen goes off as usual ${whileText(live.activity)}.`);
        },
      }, `Keep the screen on ${whileText(live.activity)}`));
    }
    if (live.on && (live.gps === 'denied' || live.gps === 'unavailable')) {
      const places = await planPlaces(ctx);
      items.push(h('p', { class: 'sub', text: places.length ? 'Where are you?' : 'Where are you? The plan has no places to choose from yet.' }));
      for (const p of places) {
        items.push(h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            close();
            await live.place(p);
            ctx.notices.toast(`annai now knows you're at ${p.name}.`);
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
  const el = h('div', { class: 'voice-chip-wrap live-wrap' }, chip, menu);
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
    const name = String(p.name ?? it.title ?? 'A plan place');
    if (!out.some((x) => x.name === name)) out.push({ name, lat: p.lat, lng: p.lng });
  }
  return out.slice(0, 8);
}
