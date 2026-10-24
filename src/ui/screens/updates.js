import { h, crumb, t } from '../dom.js';
import { relTime, list, sentences } from '../format.js';
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
  if (checking) return { said: t`Checking annai and its plugins…`, failed: [] };
  const when = checkedAt === null ? t`annai hasn't checked since it started.` : t`Last checked ${relTime(checkedAt, now)}.`;
  if (last?.offline) return { said: sentences(t`annai is offline, so it couldn't check. It checks again when you come back to it with a connection.`, checkedAt === null ? '' : when), failed: [] };
  if (last?.failed.length) return { said: sentences(when, t`Not everything could be checked:`), failed: last.failed };
  return { said: last && !waits ? sentences(when, t`Everything is up to date.`) : when, failed: [] };
}

/** @param {any} ctx */
export async function renderUpdates(ctx) {
  /** @type {Updates | undefined} */
  const u = ctx.updates;
  const plugins = (await u?.plugins().catch(() => [])) ?? [];
  const app = u?.waiting ? 'waiting' : (u?.app?.state() ?? 'none');
  const rows = await ctx.plugins.describe().catch(() => []);
  const names = (/** @type {(r: any) => boolean} */ is) => list(rows.filter(is).map((/** @type {any} */ r) => r.name), 'plain');
  const restart = names((r) => r.restart);
  const fromFile = names((r) => r.source === 'file');
  const status = statusWords(u ?? { checking: false, last: null, checkedAt: null }, app !== 'none' || plugins.length > 0);
  const check = h('button', {
    class: 'btn', type: 'button', disabled: !u || u.checking,
    onclick: () => {
      check.disabled = true;
      check.textContent = t`Checking…`;
      u?.checkNow().catch(() => {}); // drawn again as it starts and ends
    },
  }, u?.checking ? t`Checking…` : t`Check now`);
  const restartButton = (/** @type {string} */ label) => {
    const b = h('button', { class: 'btn pri', type: 'button', onclick: () => { b.disabled = true; b.textContent = t`Restarting…`; restartAnnai(ctx); } }, label);
    return b;
  };
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/settings', t`Settings`)),
    h('h1', { class: 'title', text: t`Updates` }),
    versionLine(ctx.version),
    h('section', { class: 'panel', 'aria-label': t`Checking for updates` },
      h('p', { text: status.said }),
      status.failed.length ? h('ul', { class: 'errors' }, ...status.failed.map((f) => h('li', { text: f }))) : null,
      h('div', { class: 'acts' }, check),
      h('p', { class: 'sub', text: t`annai checks by itself when it starts and when you come back to it, at most every 15 minutes. Plugins installed from an address are checked there at most once a day, so their sites aren't asked every time; Check now asks them too. Nothing changes until you tap Restart or Update.` })),
    app === 'none' ? null : section(t`A new version of annai`,
      app === 'waiting'
        ? [h('p', { text: t`It is ready, and annai uses it the next time it starts. Restart now to use it at once: if Shiori is in the middle of something, annai restarts once she has finished.` }),
          h('div', { class: 'acts' }, restartButton(t`Restart now`))]
        : h('p', { class: 'sub', text: t`It is downloading. Restart now shows here once it is ready.` })),
    plugins.length || restart || fromFile ? section(t`Plugins`,
      plugins.length ? h('ul', { class: 'cards' }, ...plugins.map((p) => h('li', { class: 'card' },
        h('span', { class: 'name', text: offerWords(p) }),
        h('div', { class: 'acts' }, updateButton(ctx, p))))) : null,
      restart ? [h('p', { text: t`Restart annai to run the new version of ${restart}.` }), h('div', { class: 'acts' }, restartButton(t`Restart annai`))] : null,
      fromFile ? h('p', { class: 'sub', text: t`Plugins installed from a file have nowhere to check for updates: ${fromFile}.` }) : null) : null);
}
