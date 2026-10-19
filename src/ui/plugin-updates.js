import { officialUpdates, updateOfficial } from '../core/llm/official.js';
import { addressUpdates, updateFromAddress } from '../core/package-updates.js';
import { addsAnything } from '../core/packages.js';
import { whatItBrings, FULL_ACCESS } from './screens/plugin-install.js';

/**
 * Plugin updates (spec §5.3): annai's own, from its catalog, and packages installed from an address,
 * from there. Offered on one card, in Settings → Updates and in Settings → Plugins; nothing changes until the user taps Update.
 * @typedef {{ fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, reload?: () => unknown,
 *   addressFetch?: (url: string, init?: RequestInit) => Promise<Response>, applied?: () => void }} Env
 *   fetch: for annai's own catalog and files; addressFetch: for addresses (traced, in the app); applied: after Update ran
 * @typedef {{ id: string, name: string, installed: string, available: string, entry?: any, url?: string, changed?: boolean,
 *   added?: import('../core/packages.js').Added, agreed?: boolean }} Update
 *   added: what an update from an address brings that the installed package didn't; agreed: the user said yes to it
 */

/** What the last checks found, by host, then by id: Settings → Updates and → Plugins show it without asking again. @type {WeakMap<any, Map<string, Update>>} */
const found = new WeakMap();
/** @param {any} host @returns {Map<string, Update>} */
const knownOf = (host) => {
  let m = found.get(host);
  if (!m) found.set(host, (m = new Map()));
  return m;
};

/**
 * Checks the kinds asked for (both by default), and keeps what each found; a kind that can't be checked
 * keeps what it found before, and says why in failed. Nothing is kept once current() is false.
 * @param {any} host @param {Env} [env] @param {{ official?: boolean, address?: boolean }} [kinds] @param {() => boolean} [current]
 * @returns {Promise<{ found: Update[], failed: string[] }>} found: every update known now, of both kinds
 */
export async function checkPlugins(host, env = {}, { official = true, address = true } = {}, current = () => true) {
  /** @type {string[]} */
  const failed = [];
  const known = knownOf(host);
  /** @param {boolean} url @param {Update[]} list */
  const keep = (url, list) => {
    for (const [id, u] of known) if (Boolean(u.url) === url) known.delete(id);
    for (const u of list) known.set(u.id, u);
  };
  if (official) {
    const now = await officialUpdates(host, env).catch((e) => { failed.push(String(e?.message ?? e).replace(/^catalog: /, '')); return null; });
    if (now && current()) keep(false, now);
  }
  if (address) {
    const now = await addressUpdates(host, { fetch: env.addressFetch ?? ((url, init) => fetch(url, init)), failed }).catch(() => null);
    if (now && current()) keep(true, now);
  }
  return { found: await knownUpdates(host), failed };
}

/** The updates the last checks found, for plugins still installed as they were. @param {any} host @returns {Promise<Update[]>} */
export async function knownUpdates(host) {
  const state = await host.installed();
  return [...knownOf(host).values()].filter((u) => state[u.id]?.source === (u.url ? 'url' : 'official') && String(state[u.id]?.version) === u.installed);
}

/** The updates the last check found at addresses, for packages still installed. @param {any} host @returns {Promise<Update[]>} */
export async function knownAddressUpdates(host) {
  return (await knownUpdates(host)).filter((u) => u.url);
}

/** "Tides 1.0.0 → 1.1.0", or "tide-pools (changed)" when only its files did. @param {Update} u */
export const offerWords = (u) => `${u.changed || u.installed === u.available ? `${u.name} (changed)` : `${u.name} ${u.installed} → ${u.available}`}${addsAnything(u.added) ? ' (brings something new: you\'ll be asked first)' : ''}`;

/** The card that offers updates; nothing changes until Update. @param {{ plugins: any, notices: any }} ctx @param {Update[]} updates @param {Env} [env] @returns {() => void} dismiss */
export function offerCard(ctx, updates, env = {}) {
  return ctx.notices.card({
    title: 'Plugin updates are ready',
    body: `New versions: ${updates.map(offerWords).join(', ')}. Nothing changes until you update. An updated plugin that is running now is off until annai restarts.`,
    actions: [{ label: 'Update', primary: true, run: () => { applyUpdates(ctx, updates, env); } }],
  });
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
      knownOf(ctx.plugins).delete(u.id);
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
  env.applied?.();
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
