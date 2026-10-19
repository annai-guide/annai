import { h } from '../dom.js';
import { relTime } from '../format.js';
import { offerWords } from '../plugin-updates.js';
import { versionLine } from './about.js';
import { updateButton, restartAnnai } from './plugins.js';

/**
 * Settings → Updates (the user, 2026-10-18): the build running, when annai last checked, Check now, a new
 * version of annai with Restart now, and each plugin update with its own Update.
 * @typedef {import('../updates.js').Updates} Updates
 */

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/** What the last check said, in plain words. @param {Pick<Updates, 'checking' | 'last' | 'checkedAt'>} u @param {boolean} waits @param {number} [now] */
export function statusWords({ checking, last, checkedAt }, waits, now = Date.now()) {
  if (checking) return { said: 'Checking annai and its plugins…', failed: [] };
  const when = checkedAt === null ? "annai hasn't checked since it started." : `Last checked ${relTime(checkedAt, now)}.`;
  if (last?.offline) return { said: `annai is offline, so it couldn't check. It checks again when you come back to it with a connection.${checkedAt === null ? '' : ` ${when}`}`, failed: [] };
  if (last?.failed.length) return { said: `${when} Not everything could be checked:`, failed: last.failed };
  return { said: last && !waits ? `${when} Everything is up to date.` : when, failed: [] };
}

/** @param {any} ctx */
export async function renderUpdates(ctx) {
  /** @type {Updates | undefined} */
  const u = ctx.updates;
  const plugins = (await u?.plugins().catch(() => [])) ?? [];
  const app = u?.waiting ? 'waiting' : (u?.app?.state() ?? 'none');
  const rows = await ctx.plugins.describe().catch(() => []);
  const names = (/** @type {(r: any) => boolean} */ is) => rows.filter(is).map((/** @type {any} */ r) => r.name).join(', ');
  const restart = names((r) => r.restart);
  const fromFile = names((r) => r.source === 'file');
  const status = statusWords(u ?? { checking: false, last: null, checkedAt: null }, app !== 'none' || plugins.length > 0);
  const check = h('button', {
    class: 'btn', type: 'button', disabled: !u || u.checking,
    onclick: () => {
      check.disabled = true;
      check.textContent = 'Checking…';
      u?.checkNow().catch(() => {}); // drawn again as it starts and ends
    },
  }, u?.checking ? 'Checking…' : 'Check now');
  const restartButton = (/** @type {string} */ label) => {
    const b = h('button', { class: 'btn pri', type: 'button', onclick: () => { b.disabled = true; b.textContent = 'Restarting…'; restartAnnai(ctx); } }, label);
    return b;
  };
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Updates' }),
    versionLine(ctx.version),
    h('section', { class: 'panel', 'aria-label': 'Checking for updates' },
      h('p', { text: status.said }),
      status.failed.length ? h('ul', { class: 'errors' }, ...status.failed.map((f) => h('li', { text: f }))) : null,
      h('div', { class: 'acts' }, check),
      h('p', { class: 'sub', text: 'annai checks by itself when it starts and when you come back to it, at most every 15 minutes. Plugins installed from an address are checked there at most once a day, so their sites aren\'t asked every time; Check now asks them too. Nothing changes until you tap Restart or Update.' })),
    app === 'none' ? null : section('A new version of annai',
      app === 'waiting'
        ? [h('p', { text: 'It is ready, and annai uses it the next time it starts. Restart now to use it at once: if Shiori is in the middle of something, annai restarts once she has finished.' }),
          h('div', { class: 'acts' }, restartButton('Restart now'))]
        : h('p', { class: 'sub', text: 'It is downloading. Restart now shows here once it is ready.' })),
    plugins.length || restart || fromFile ? section('Plugins',
      plugins.length ? h('ul', { class: 'cards' }, ...plugins.map((p) => h('li', { class: 'card' },
        h('span', { class: 'name', text: offerWords(p) }),
        h('div', { class: 'acts' }, updateButton(ctx, p))))) : null,
      restart ? [h('p', { text: `Restart annai to run the new version of ${restart}.` }), h('div', { class: 'acts' }, restartButton('Restart annai'))] : null,
      fromFile ? h('p', { class: 'sub', text: `Plugins installed from a file have nowhere to check for updates: ${fromFile}.` }) : null) : null);
}
