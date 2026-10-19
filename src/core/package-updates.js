import { fetchPackage, addedParts, addsAnything, agreedTo, addedWords } from './packages.js';
import { PluginError } from './registry.js';
import { installRequirements, checkPackageId } from './requires.js';

/**
 * Updates for packages installed from an address (spec §5.3: "those installed from a URL get the
 * same check"). A package changed when its fingerprint did (choice 7), so a skill without a version
 * is offered too. Nothing changes until the user accepts.
 * @typedef {import('./plugins.js').PluginHost} PluginHost
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {{ id: string, name: string, installed: string, available: string, url: string, kind: string, changed: boolean,
 *   added: import('./packages.js').Added }} AddressUpdate  added: what it brings that the installed one doesn't; anything there asks first
 */

/**
 * The packages installed from an address that have changed there. One that can't be checked now
 * (offline, broken, now another package) is left out quietly, or said in failed when it's given (Check now).
 * @param {PluginHost} host @param {{ fetch: Fetch, failed?: string[] }} o @returns {Promise<AddressUpdate[]>}
 */
export async function addressUpdates(host, { fetch, failed }) {
  /** @type {AddressUpdate[]} */
  const out = [];
  for (const [id, s] of Object.entries(await host.installed())) {
    if (s.source !== 'url' || typeof s.url !== 'string') continue;
    try {
      // The address with its keys, from the package's secret (fix pass 8a-1); s.url shows «key» in their places.
      const address = await host.address(id);
      if (!address) continue;
      const pkg = await host.inspect(await fetchPackage(address, { fetch }));
      if (pkg.id !== id || pkg.fingerprint === s.fingerprint) continue;
      const added = pkg.replaces?.added ?? addedParts(await host.installedParts(id), pkg);
      out.push({ id, name: pkg.name, installed: String(s.version), available: pkg.version, url: (await host.installed())[id]?.url ?? s.url, kind: pkg.kind, changed: pkg.version === s.version && !addsAnything(added), added });
    } catch (e) {
      // not now: the next check asks again
      failed?.push(`${s.name ?? id} couldn't be checked: ${/** @type {any} */ (e)?.message ?? e}`);
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
  if (!s || !address) throw new PluginError(id, "wasn't installed from an address, so annai has nowhere to look for an update");
  const files = await fetchPackage(address, { fetch });
  const pkg = await host.inspect(files);
  if (pkg.id !== id) throw new PluginError(id, `the address now holds another package (${pkg.id}), so it wasn't updated. Remove this one and install that one if you want it.`);
  const added = pkg.replaces?.added ?? addedParts(await host.installedParts(id), pkg);
  if (!agreedTo(agreed, added)) throw new PluginError(id, `this update adds parts you haven't agreed to: ${addedWords(added)}. Check for updates again and look at what it adds.`);
  await checkPackageId(host, id, 'url', official); // annai's own names stay annai's (security review)
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
