import { h, t } from './dom.js';
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
 * The GPS chip (spec §11.1: live mode is a switch), one tap away on every screen next to the voice chip. One tap turns GPS on or off at
 * once: the phone's own permission prompt is the only other step (the user, the second drive). While a simulation runs, which has live
 * mode, a tap opens its menu instead. The screen kept on is in Settings → Voice; "Where are you?" on the Driving screen.
 * @param {any} ctx
 */
export function liveChip(ctx) {
  const live = ctx.live;
  const chip = h('button', { class: 'chip live-chip', type: 'button' });
  const menu = h('div', { id: 'live-menu', class: 'voice-menu live-menu', role: 'group', 'aria-label': /* en */ 'GPS', hidden: true });
  /** A tap anywhere else closes it. @param {Event} e */
  const outside = (e) => { if (!el.contains(/** @type {Node} */ (e.target))) close(); };
  const close = () => {
    menu.hidden = true;
    menu.replaceChildren();
    if (ctx.sim?.running) chip.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  /** A simulation has live mode: the chip pauses or stops it (7b choice 10). */
  const open = () => {
    const sim = ctx.sim;
    chip.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    menu.replaceChildren(
      h('button', { class: 'btn', type: 'button', onclick: () => { close(); if (sim.state?.paused) sim.resume(); else sim.pause(); } }, sim.state?.paused ? t`Resume the simulation` : t`Pause the simulation`),
      h('button', { class: 'btn', type: 'button', onclick: () => { close(); sim.stop(); } }, t`Stop the simulation`),
      h('a', { class: 'btn', href: '#/simulate', onclick: () => close() }, t`Simulate a trip`));
    menu.hidden = false;
  };
  chip.addEventListener('click', () => {
    if (!ctx.sim?.running) live.setLive(!live.on);
    else if (menu.hidden) open();
    else close();
  });

  const show = () => {
    const sim = Boolean(ctx.sim?.running);
    if (!sim && !menu.hidden) close();
    chip.textContent = liveText(live);
    chip.classList.toggle('on', live.on);
    // A switch, or the button of a simulation's menu.
    if (sim) {
      chip.removeAttribute('aria-pressed');
      chip.setAttribute('aria-haspopup', 'true');
      chip.setAttribute('aria-controls', 'live-menu');
      chip.setAttribute('aria-expanded', String(!menu.hidden));
    } else {
      chip.setAttribute('aria-pressed', String(live.on));
      for (const a of ['aria-haspopup', 'aria-controls', 'aria-expanded']) chip.removeAttribute(a);
    }
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
