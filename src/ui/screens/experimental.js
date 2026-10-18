import { h, checkbox } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';

/**
 * Settings → Experimental (the user, 2026-10-18): features still being tried, each off until turned
 * on, kept under experimental in the app's settings. Each is a panel of its own; more join the list.
 * @param {any} ctx
 */
export async function renderExperimental(ctx) {
  const app = await readAppSettings(ctx.ws);
  const swipes = checkbox('Swipe sideways to move between tabs', app.experimental?.swipeTabs === true);
  swipes.input.addEventListener('change', async () => {
    const on = swipes.input.checked;
    await updateAppSettings(ctx.ws, { experimental: { swipeTabs: on } });
    ctx.setSwipes?.(on);
  });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Experimental' }),
    h('p', { class: 'sub', text: 'Features that are still being tried. They may have bugs, and their fixes may come slower than the rest of annai.' }),
    h('section', { class: 'panel', 'aria-label': 'Swiping between tabs' },
      swipes.el,
      h('p', { class: 'sub', text: "Swipe a screen left or right to go to the next or the previous tab of the top bar, back to the screen you last had open there. Off, a sideways swipe does what the browser does." })));
}
