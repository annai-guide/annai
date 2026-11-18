import { fetchPackage, addedParts, addsAnything, agreedTo, addedWords } from './packages.js';
import { t } from './l10n.js';
import { PluginError } from './registry.js';
import { installRequirements, checkPackageId } from './requires.js';

/**
 * Updates for packages installed from an address (spec §5.3: "those installed from a URL get the
 * same check"). A package changed when its fingerprint did, so a skill without a version
 * is offered too. Nothing changes until the user accepts.
 * @typedef {import('./plugins.js').PluginHost} PluginHost
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {{ id: string, name: string, installed: string, available: string, url: string, kind: string, changed: boolean,
 *   added: import('./packages.js').Added }} AddressUpdate  added: what it brings that the installed one doesn't; anything there asks first
 */

/**
 * The packages installed from an address that have changed there, in the order they are listed. One that can't be checked now
 * (offline, broken, a site that stopped answering) is left out quietly, or said in failed when it's given (Check now), with its id in
 * unchecked: what an earlier check found for it stands. One that is now another package is checked, and has nothing to offer. The
 * addresses are asked side by side, so any number of dead sites end together (answer.js), inside the check's own limit.
 * @param {PluginHost} host @param {{ fetch: Fetch, failed?: string[], unchecked?: Set<string> }} o @returns {Promise<AddressUpdate[]>}
 */
export async function addressUpdates(host, { fetch, failed, unchecked }) {
  const checked = await Promise.all(Object.entries(await host.installed()).map(async ([id, s]) => {
    if (s.source !== 'url' || typeof s.url !== 'string') return {};
    try {
      // The address with its keys, from the package's secret; s.url shows «key» in their places.
      const address = await host.address(id);
      if (!address) return {};
      const pkg = await host.inspect(await fetchPackage(address, { fetch }));
      if (pkg.id !== id || pkg.fingerprint === s.fingerprint) return {};
      const added = pkg.previous?.added ?? addedParts(await host.installedParts(id), pkg);
      /** @type {AddressUpdate} */
      const update = { id, name: pkg.name, installed: String(s.version), available: pkg.version, url: (await host.installed())[id]?.url ?? s.url, kind: pkg.kind, changed: pkg.version === s.version && !addsAnything(added), added };
      return { update };
    } catch (e) {
      // not now: the next check asks again
      return { id, why: t`${s.name ?? id} couldn't be checked: ${String(/** @type {any} */ (e)?.shown ?? /** @type {any} */ (e)?.message ?? e)}` };
    }
  }));
  /** @type {AddressUpdate[]} */
  const out = [];
  for (const c of checked) {
    if (c.update) out.push(c.update);
    if (c.id && c.why) {
      failed?.push(c.why);
      unchecked?.add(c.id);
    }
  }
  return out;
}

/**
 * Installs what the address holds now, keeping the package off if it was off. Code that already ran
 * this session runs from the next start, as for annai's own plugins. What it brings that the installed
 * one didn't (code, skills, personalities, where its provider sends keys) must be what the user agreed
 * to (agreed). What it now requires is installed first, from annai's catalog (official: how to reach it).
 * @param {PluginHost} host @param {string} id
 * @param {{ fetch: Fetch, agreed?: import('./packages.js').Added, official?: import('./llm/official.js').FetchOptions }} o @returns {Promise<'started' | 'restart'>}
 */
export async function updateFromAddress(host, id, { fetch, agreed, official = {} }) {
  const s = (await host.installed())[id];
  const address = await host.address(id);
  /* en */
  if (!s || !address) throw new PluginError(id, "wasn't installed from an address, so annai has nowhere to look for an update", { shown: t`It wasn't installed from an address, so annai has nowhere to look for an update.` });
  const files = await fetchPackage(address, { fetch });
  const pkg = await host.inspect(files);
  /* en */
  if (pkg.id !== id) throw new PluginError(id, `the address now holds another package (${pkg.id}), so it wasn't updated. Remove this one and install that one if you want it.`, { shown: t`The address now holds another package (${pkg.id}), so it wasn't updated. Remove this one and install that one if you want it.` });
  const added = pkg.previous?.added ?? addedParts(await host.installedParts(id), pkg);
  // The log's English says that it adds parts; the screens' words say which.
  /* en */
  if (!agreedTo(agreed, added)) throw new PluginError(id, "this update adds parts you haven't agreed to. Check for updates again and look at what it adds.", { shown: t`This update adds parts you haven't agreed to: ${addedWords(added)}. Check for updates again and look at what it adds.` });
  await checkPackageId(host, id, 'url', official); // annai's own names stay annai's
  if (pkg.requires.length) await installRequirements(host, pkg.requires, { ...official, tap: true }, { who: pkg.name, id }); // Update is the user's tap
  const wasOn = s.enabled !== false;
  await host.install(files, { source: 'url', url: address });
  if (!wasOn) {
    await host.setEnabled(id, false);
    return 'started';
  }
  if (host.needsRestart(id)) return 'restart';
  await host.start(id);
  return 'started';
}
