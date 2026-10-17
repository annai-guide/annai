import { officialUpdates, updateOfficial } from '../core/llm/official.js';
import { addressUpdates, updateFromAddress } from '../core/package-updates.js';

/**
 * Plugin updates (spec §5.3): annai's own, from its catalog, and packages installed from an address,
 * from there. Offered on one card and in Settings → Plugins; nothing changes until the user taps Update.
 * @typedef {{ fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, reload?: () => void,
 *   addressFetch?: (url: string, init?: RequestInit) => Promise<Response> }} Env
 *   fetch: for annai's own catalog and files; addressFetch: for addresses (traced, in the app)
 * @typedef {{ id: string, name: string, installed: string, available: string, entry?: any, url?: string, changed?: boolean }} Update
 */

/** Every update there is now, of both kinds; a kind that can't be checked (offline) gives none. @param {any} host @param {Env} [env] @returns {Promise<Update[]>} */
export async function pluginUpdates(host, env = {}) {
  const official = await officialUpdates(host, env).catch(() => []);
  const addressed = await addressUpdates(host, { fetch: env.addressFetch ?? ((url, init) => fetch(url, init)) }).catch(() => []);
  return [...official, ...addressed];
}

/** "Tides 1.0.0 → 1.1.0", or "tide-pools (changed)" when only its files did. @param {Update} u */
const offerWords = (u) => (u.changed || u.installed === u.available ? `${u.name} (changed)` : `${u.name} ${u.installed} → ${u.available}`);

/**
 * Looks for updates, and offers them on one card. Quiet when offline or when there is nothing new.
 * @param {{ plugins: any, notices: any }} ctx @param {Env} [env]
 */
export async function offerPluginUpdates(ctx, env = {}) {
  const updates = await pluginUpdates(ctx.plugins, env);
  if (!updates.length) return updates;
  ctx.notices.card({
    title: 'Plugin updates are ready',
    body: `New versions: ${updates.map(offerWords).join(', ')}. Nothing changes until you update. An updated plugin that is running now is off until annai restarts.`,
    actions: [{ label: 'Update', primary: true, run: () => { applyUpdates(ctx, updates, env); } }],
  });
  return updates;
}

/**
 * Installs the updates the user accepted, and says what happened: done, done after a restart, or
 * which ones failed and why.
 * @param {{ plugins: any, notices: any }} ctx @param {Update[]} updates @param {Env} [env]
 */
export async function applyUpdates(ctx, updates, env = {}) {
  /** @type {string[]} the ones that are off until annai restarts */
  const waiting = [];
  /** @type {string[]} */
  const failed = [];
  for (const u of updates) {
    try {
      const how = u.url
        ? await updateFromAddress(ctx.plugins, u.id, { fetch: env.addressFetch ?? ((url, init) => fetch(url, init)) })
        : await updateOfficial(ctx.plugins, u.entry, env);
      if (how === 'restart') waiting.push(u.name);
    } catch (e) {
      failed.push(`${u.name}: ${/** @type {any} */ (e)?.message ?? e}`);
    }
  }
  if (failed.length) ctx.notices.card({ tone: 'warn', title: "Some plugins weren't updated", body: failed.join(' ') });
  if (waiting.length) {
    ctx.notices.card({
      tone: 'warn',
      title: 'Restart annai to use the new versions',
      body: `The update is installed and runs the next time annai starts. Until then, ${waiting.join(' and ')} can't be used.`,
      actions: [{ label: 'Restart now', primary: true, run: env.reload ?? (() => location.reload()) }],
    });
  } else if (!failed.length) {
    ctx.notices.toast('Plugins updated.');
  }
}
