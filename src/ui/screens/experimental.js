import { h, crumb, savedCheck, t } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { EXPERIMENTAL } from '../../core/l10n-list.js';
import { ownName } from '../languages.js';

/**
 * Settings → Experimental: features still being tried, and developer tools. A switch keeps its choice under experimental in the app's settings
 * (Unfinished translations, offered only while a language is marked experimental); Remote trace is an official plugin to install. Each is a
 * panel of its own; more join the list.
 * @param {any} ctx
 */
export async function renderExperimental(ctx) {
  const app = await readAppSettings(ctx.ws);
  const traceInstalled = Boolean((await ctx.plugins?.installed?.().catch(() => ({})))?.['remote-trace']);
  // Offered only while annai has a translation that is still a draft (localization decision 5).
  const unfinished = savedCheck(t`Unfinished translations`, app.experimental?.unfinishedTranslations === true, async (on) => {
    await updateAppSettings(ctx.ws, { experimental: { unfinishedTranslations: on } });
  });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/settings', t`Settings`)),
    h('h1', { class: 'title', text: t`Experimental` }),
    h('p', { class: 'sub', text: t`Features that are still being tried. They may have bugs, and their fixes may come slower than the rest of annai.` }),
    EXPERIMENTAL.length ? h('section', { class: 'panel', 'aria-label': t`Unfinished translations` },
      unfinished.el,
      h('p', { class: 'sub', text: t`Translations that nobody who reads the language has checked yet. On, you can choose them in Settings → Languages. Their wording may be wrong, and what isn't translated yet stays in English.` }),
      h('ul', { class: 'langs' }, ...EXPERIMENTAL.map((tag) => h('li', { lang: tag, text: ownName(tag) })))) : null,
    // An official plugin rather than a switch: most people never need it.
    h('section', { class: 'panel', 'aria-label': t`Remote trace (for developers)` },
      h('h2', { class: 'section', text: t`Remote trace (for developers)` }),
      h('p', { class: 'sub', text: t`Sends annai's trace to a server you run, to see what annai does on this phone as it happens. Off until you set it up; a chip in the dock shows while it sends.` }),
      h('div', { class: 'acts' }, traceInstalled
        ? h('a', { class: 'btn', href: '#/plugins/remote-trace' }, t`Open Remote trace`)
        : h('a', { class: 'btn', href: '#/add?kind=developer&from=experimental' }, t`Get it from annai's catalog`))));
}
