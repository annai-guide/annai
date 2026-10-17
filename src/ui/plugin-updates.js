import { officialUpdates, updateOfficial } from '../core/llm/official.js';
import { addressUpdates, updateFromAddress } from '../core/package-updates.js';
import { addsAnything } from '../core/packages.js';
import { whatItBrings, FULL_ACCESS } from './screens/plugin-install.js';

/**
 * Plugin updates (spec §5.3): annai's own, from its catalog, and packages installed from an address,
 * from there. Offered on one card and in Settings → Plugins; nothing changes until the user taps Update.
 * @typedef {{ fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, reload?: () => void,
 *   addressFetch?: (url: string, init?: RequestInit) => Promise<Response> }} Env
 *   fetch: for annai's own catalog and files; addressFetch: for addresses (traced, in the app)
 * @typedef {{ id: string, name: string, installed: string, available: string, entry?: any, url?: string, changed?: boolean,
 *   added?: import('../core/packages.js').Added, agreed?: boolean }} Update
 *   added: what an update from an address brings that the installed package didn't; agreed: the user said yes to it
 */

/** @type {Map<string, Update>} what the last check found at addresses, by id: Settings → Plugins shows it without asking every address again */
const known = new Map();

/** Every update there is now, of both kinds; a kind that can't be checked (offline) gives none. @param {any} host @param {Env} [env] @returns {Promise<Update[]>} */
export async function pluginUpdates(host, env = {}) {
  const official = await officialUpdates(host, env).catch(() => []);
  const addressed = await addressUpdates(host, { fetch: env.addressFetch ?? ((url, init) => fetch(url, init)) }).catch(() => null);
  if (addressed) {
    known.clear();
    for (const u of addressed) known.set(u.id, u);
  }
  return [...official, ...(addressed ?? [])];
}

/** The updates the last check found at addresses, for packages still installed. @param {any} host @returns {Promise<Update[]>} */
export async function knownAddressUpdates(host) {
  const state = await host.installed();
  return [...known.values()].filter((u) => state[u.id]?.source === 'url' && String(state[u.id]?.version) === u.installed);
}

/** "Tides 1.0.0 → 1.1.0", or "tide-pools (changed)" when only its files did. @param {Update} u */
const offerWords = (u) => `${u.changed || u.installed === u.available ? `${u.name} (changed)` : `${u.name} ${u.installed} → ${u.available}`}${addsAnything(u.added) ? ' (brings something new: you\'ll be asked first)' : ''}`;

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
  let applied = 0;
  for (const u of updates) {
    // Official plugins are annai's own, checked against its catalog's hashes: they update as they are (ruling).
    if (u.url && addsAnything(u.added) && !u.agreed) {
      askFirst(ctx, u, env);
      continue;
    }
    try {
      const how = u.url
        ? await updateFromAddress(ctx.plugins, u.id, { fetch: env.addressFetch ?? ((url, init) => fetch(url, init)), ...(u.agreed ? { agreed: u.added } : {}) })
        : await updateOfficial(ctx.plugins, u.entry, env);
      applied++;
      if (u.url) known.delete(u.id);
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
  } else if (!failed.length && applied) {
    ctx.notices.toast('Plugins updated.');
  }
}

/**
 * An update from an address that brings something new asks first, listing it (the coordinator's second
 * finding); new code asks with the install screen's full-trust words. Nothing changes until Update.
 * @param {{ plugins: any, notices: any }} ctx @param {Update} u @param {Env} env
 */
function askFirst(ctx, u, env) {
  const added = /** @type {import('../core/packages.js').Added} */ (u.added);
  ctx.notices.card({
    tone: added.code ? 'risk' : 'warn',
    title: `${u.name} ${u.available} brings something new`,
    body: `New in this version: ${whatItBrings(added).join('; ')}.${added.code ? ` ${FULL_ACCESS} Only update if you trust where it came from.` : ''} Nothing changes until you tap Update.`,
    actions: [
      { label: 'Update', primary: true, run: () => applyUpdates(ctx, [{ ...u, agreed: true }], env) },
      { label: 'Not now', run: () => {} },
    ],
  });
}
