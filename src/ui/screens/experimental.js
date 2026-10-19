import { h, savedCheck } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';

/**
 * Settings → Experimental (the user, 2026-10-18): features still being tried, each off until turned
 * on, kept under experimental in the app's settings. Each is a panel of its own; more join the list.
 * @param {any} ctx
 */
export async function renderExperimental(ctx) {
  const app = await readAppSettings(ctx.ws);
  const traceInstalled = Boolean((await ctx.plugins?.installed?.().catch(() => ({})))?.['remote-trace']);
  const swipes = savedCheck('Swipe sideways to move between tabs', app.experimental?.swipeTabs === true, async (on) => {
    await updateAppSettings(ctx.ws, { experimental: { swipeTabs: on } });
    ctx.setSwipes?.(on);
  });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Experimental' }),
    h('p', { class: 'sub', text: 'Features that are still being tried. They may have bugs, and their fixes may come slower than the rest of annai.' }),
    h('section', { class: 'panel', 'aria-label': 'Swiping between tabs' },
      swipes.el,
      h('p', { class: 'sub', text: "Swipe a screen left or right to go to the next or the previous tab of the top bar, back to the screen you last had open there. Off, a sideways swipe does what the browser does." })),
    // An official plugin rather than a switch: most people never need it (the user, 2026-10-18).
    h('section', { class: 'panel', 'aria-label': 'Remote trace (for developers)' },
      h('h2', { class: 'section', text: 'Remote trace (for developers)' }),
      h('p', { class: 'sub', text: "Sends annai's trace to a server you run, to see what annai does on this phone as it happens. Off until you set it up; a chip in the dock shows while it sends." }),
      h('div', { class: 'acts' }, traceInstalled
        ? h('a', { class: 'btn', href: '#/plugins/remote-trace' }, 'Open Remote trace')
        : h('a', { class: 'btn', href: '#/add' }, "Get it from annai's catalog"))));
}
