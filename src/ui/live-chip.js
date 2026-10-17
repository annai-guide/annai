import { h } from './dom.js';
import { PLAN_FILE } from '../core/plan.js';

const DOING = /** @type {Record<string, string>} */ ({ 'moving-fast': 'moving fast', walking: 'walking', still: 'stopped' });

/** The live chip's words. @param {{ on: boolean, gps: string, activity: string, fix: unknown }} live */
export function liveText(live) {
  if (!live.on) return 'Live off';
  if (!live.fix) return live.gps === 'denied' ? 'Live · no location' : live.gps === 'unavailable' ? 'Live · no GPS' : 'Live · finding you';
  return DOING[live.activity] ? `Live · ${DOING[live.activity]}` : 'Live on';
}

/** "Keep the screen on while driving or riding". @param {string} activity */
export function whileText(activity) {
  return /** @type {Record<string, string>} */ ({ 'moving-fast': 'while driving or riding', walking: 'while walking', still: 'while stopped' })[activity] ?? 'in live mode';
}

/**
 * The live chip (spec §11.1: live mode is a switch), one tap away on every screen next to the voice
 * chip. A tap shows the switch; with live mode on, "Keep the screen on" for this situation; and with
 * no GPS, "Where are you?", the trip's plan places (§17: "a manual place").
 * @param {any} ctx
 */
export function liveChip(ctx) {
  const live = ctx.live;
  const chip = h('button', { class: 'chip live-chip', type: 'button', 'aria-expanded': 'false' });
  const menu = h('div', { class: 'voice-menu live-menu', role: 'group', 'aria-label': 'Live mode', hidden: true });
  const close = () => {
    menu.hidden = true;
    menu.replaceChildren();
    chip.setAttribute('aria-expanded', 'false');
  };
  const open = async () => {
    const items = [h('button', {
      class: 'btn', type: 'button', 'aria-pressed': String(live.on),
      onclick: async () => {
        close();
        await live.setLive(!live.on);
      },
    }, live.on ? 'Turn live mode off' : 'Turn live mode on')];
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
            ctx.notices.toast(`Live mode takes it you are at ${p.name}.`);
          },
        }, p.name));
      }
    }
    menu.replaceChildren(...items);
    menu.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
  };
  chip.addEventListener('click', () => { if (menu.hidden) open(); else close(); });

  const show = () => {
    chip.textContent = liveText(live);
    chip.classList.toggle('on', live.on);
  };
  live.onChange(show);
  show();
  const el = h('div', { class: 'voice-chip-wrap' }, chip, menu);
  // Escape closes it, from the chip or from inside the menu.
  el.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    close();
    chip.focus();
  });
  return { el };
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
