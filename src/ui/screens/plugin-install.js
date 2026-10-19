import { h, messageOf as message } from '../dom.js';
import { andList } from '../format.js';
import { pendingPackage, setPendingPackage } from '../plugin-pending.js';
import { explainStorageFull } from '../storage-full.js';
import { addressParts } from '../../core/address.js';
import { addsAnything } from '../../core/packages.js';
import { descOrigins } from '../../core/llm/provider-desc.js';
import { officialPlugins } from '../../core/llm/official.js';
import { checkRequires, installWith, checkPackageId } from '../../core/requires.js';

/** The spec's own words for a package with code (§5.1). */
export const FULL_ACCESS = 'This plugin gets full access to your trips and API keys.';

/**
 * What a package brings, one line each (choice 8 of milestone 8a): its code, skills, personalities,
 * its model provider, and (in an update) the new origins its provider sends keys to.
 * @param {{ code: boolean, skills: any[], personalities: any[], provider?: any, origins?: string[] }} pkg @returns {string[]}
 */
export function whatItBrings(pkg) {
  const out = [];
  if (pkg.code) out.push('Code that runs in annai');
  for (const s of pkg.skills ?? []) out.push(`Skill "${s.name}": ${s.description}`);
  for (const p of pkg.personalities ?? []) out.push(`Personality "${p.name}"`);
  if (pkg.provider) out.push(`A model provider: ${abilityWords(pkg.provider)}`);
  if (pkg.origins?.length) out.push(`Its provider now sends keys you give it to ${pkg.origins.join(', ')}`);
  return out.length ? out : ['Nothing annai uses yet'];
}


/**
 * Where a provider sends the keys a user gives it, by origin with its scheme (security review): said on
 * a fresh install as on an update. null for a package that isn't a provider.
 * @param {{ provider?: any }} pkg @returns {string | null}
 */
export function keysNote(pkg) {
  if (!pkg.provider) return null;
  const origins = descOrigins(pkg.provider);
  return origins.length ? `Keys you give this provider are sent to ${andList(origins)}.` : 'Keys you give this provider are sent only to the address you give it.';
}

/**
 * What a package needs, in words, and whether it can be had now (spec §5.3), as the install will judge
 * it (checkRequires): annai's own come with it; a third party's must be installed already.
 * @param {any} ctx @param {{ id: string, name: string, requires?: import('../../core/packages.js').Requirement[] }} pkg @returns {Promise<{ text: string, ok: boolean }>}
 */
export async function needsOf(ctx, pkg) {
  const requires = (pkg.requires ?? []).filter((r) => r.id !== pkg.id);
  if (!requires.length) return { text: '', ok: true };
  const catalog = await officialPlugins().catch(() => null);
  try {
    const plan = await checkRequires(ctx.plugins, requires, catalog ?? [], { who: pkg.name, except: pkg.id });
    const state = await ctx.plugins.installed();
    return { ok: true, text: `It needs: ${requires.map((r) => (plan.some((e) => e.id === r.id) ? `${plan.find((e) => e.id === r.id)?.name} (from annai, installed with it)` : `${state[r.id]?.name ?? r.id} (installed)`)).join('; ')}.` };
  } catch (e) {
    return { ok: false, text: catalog ? message(e) : "annai's catalog couldn't be loaded to look for what it needs. Connect to the internet and try again." };
  }
}

/** A provider's abilities in words: "chat, transcription and voice". @param {any} desc */
export function abilityWords(desc) {
  return andList([...new Set(Object.values(desc?.abilities ?? {}).map((/** @type {any} */ a) => String(a?.kind)))]) || 'nothing yet';
}

/**
 * Where a package came from, in words: its address as annai keeps it, with «key» for each key in it
 * (fix pass 8a-1), a file, or annai.
 * @param {{ source?: string, url?: string, file?: string }} from
 */
export function sourceLine(from) {
  if (from?.source === 'url' && from.url) {
    let kept = '';
    try {
      kept = addressParts(from.url).shown.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    } catch {
      return 'From an address';
    }
    let shown = kept;
    try {
      shown = decodeURI(kept);
    } catch {
      // keep the escapes
    }
    return `From ${shown}`;
  }
  if (from?.source === 'file') return from.file ? `From a file: ${from.file}` : 'From a file';
  return 'From annai';
}

/** An http(s) address or null. @param {unknown} url */
function webAddress(url) {
  try {
    const u = new URL(String(url ?? ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** The card that says annai must start again to run new code. @param {any} ctx @param {string} name */
export function restartCard(ctx, name) {
  ctx.notices.card({
    title: `Restart annai to run the new version of ${name}.`, body: 'The browser keeps the old code until annai starts again.',
    actions: [{ label: 'Restart annai', primary: true, run: () => ctx.updates?.restart() ?? location.reload() }], // after Shiori's turn (Updates.restart)
  });
}

/**
 * The install screen (spec §5.1, choice 8): what the package is, where it came from, what it brings
 * and may do, before anything is stored.
 * @param {any} ctx
 */
export async function renderPluginInstall(ctx) {
  const p = pendingPackage();
  const back = h('p', { class: 'crumbs' }, h('a', { href: '#/plugins' }, '← Plugins'));
  if (!p) {
    return h('div', { class: 'screen' }, back, h('h1', { class: 'title', text: 'Nothing to install' }),
      h('p', {}, "There's nothing to install. ", h('a', { href: '#/plugins' }, 'Go back to Plugins.')));
  }
  const { pkg, from } = p;
  const what = pkg.kind === 'skill' ? 'A skill' : pkg.provider && !pkg.code ? 'A model provider · data only' : pkg.code ? 'A plugin' : 'A package without code';
  const line = [what, pkg.shownVersion ? `version ${pkg.shownVersion}` : null, pkg.author ? `by ${pkg.author}` : null].filter(Boolean).join(' · ');
  const home = webAddress(pkg.homepage);
  const needs = await needsOf(ctx, pkg);
  // A package from elsewhere can't take the name of annai's own plugin (security review).
  const taken = await checkPackageId(ctx.plugins, pkg.id, from?.source).then(() => null, (e) => message(e));
  const install = h('button', { class: 'btn pri', type: 'button', disabled: !needs.ok || Boolean(taken), onclick: () => installPending(ctx, install) }, 'Install');
  return h('div', { class: 'screen plugin-install' }, back,
    h('h1', { class: 'title', text: `Install ${pkg.name}?` }),
    h('p', { class: 'sub', text: line }),
    home ? h('p', {}, h('a', { href: home, target: '_blank', rel: 'noopener noreferrer', text: home })) : null,
    pkg.description ? h('p', { text: pkg.description }) : null,
    h('p', { class: 'sub', text: sourceLine(from) }),
    taken ? h('p', { class: 'error', role: 'alert', text: taken }) : null,
    h('section', { class: 'panel', 'aria-label': 'What it brings' },
      h('h2', { class: 'section', text: 'What it brings' }),
      h('ul', { class: 'brings' }, ...whatItBrings(pkg).map((t) => h('li', { text: t }))),
      needs.text ? h('p', { class: needs.ok ? 'sub' : 'error', text: needs.text }) : null),
    pkg.code
      ? h('div', { class: 'risk-note', role: 'note' }, h('p', { text: FULL_ACCESS }), h('p', { text: 'Only install it if you trust where it came from.' }), keysNote(pkg) ? h('p', { text: keysNote(pkg) }) : null)
      : pkg.provider
        // A provider's own note, in place of the skill note (security review): what it can't do, and where keys go.
        ? h('div', { class: 'skill-note', role: 'note' }, h('p', { text: "It can't run anything: it is data that tells annai how to reach a model provider." }), h('p', { text: keysNote(pkg) }))
        : h('p', { class: 'skill-note', text: 'A skill is instructions for Shiori: she reads them when they fit what you ask, and follows what they say. annai never runs anything in it, so install skills you trust.' }),
    pkg.replaces ? h('p', { class: 'sub', text: `Version ${pkg.replaces.version} is installed now. Installing replaces it.` }) : null,
    // What a new version adds is said on its own, so nothing new slips in with an update (the coordinator's second finding).
    pkg.replaces && addsAnything(pkg.replaces.added) ? h('section', { class: 'panel', 'aria-label': 'New in this version' },
      h('h2', { class: 'section', text: 'New in this version' }),
      h('ul', { class: 'brings' }, ...whatItBrings(pkg.replaces.added).map((t) => h('li', { text: t })))) : null,
    h('div', { class: 'acts' }, install,
      h('button', { class: 'btn', type: 'button', onclick: () => { setPendingPackage(null); ctx.go('#/plugins'); } }, 'Cancel')));
}

/** Installs the package on screen, then starts it; each step that fails says so. @param {any} ctx @param {HTMLButtonElement} button */
async function installPending(ctx, button) {
  const p = pendingPackage();
  if (!p) return;
  const { pkg } = p;
  button.disabled = true;
  try {
    // What it needs (annai's own, from its catalog) may be code too.
    if ((pkg.code || pkg.requires?.length) && !navigator.serviceWorker?.controller) {
      throw new Error("Plugins load through annai's offline service, which isn't running yet. Reload annai and try again.");
    }
    if (pkg.requires?.length) {
      // With what it requires, all or nothing, and started (spec §5.3).
      await installWith(ctx.plugins, p.files, p.from, { tap: true });
      setPendingPackage(null);
      ctx.notices.toast(`Installed ${pkg.name}.`);
      ctx.go('#/plugins');
      return;
    }
    await checkPackageId(ctx.plugins, pkg.id, p.from?.source);
    await ctx.plugins.install(p.files, p.from);
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: `${pkg.name} wasn't installed`, body: message(e) });
    button.disabled = false;
    return;
  }
  setPendingPackage(null);
  if ((await ctx.plugins.installed())[pkg.id]?.enabled === false) {
    // A new version of one that is off stays off, and its code doesn't run (fix pass 8a-5).
    ctx.notices.toast(`Updated ${pkg.name}. It stays off.`);
  } else if (ctx.plugins.needsRestart(pkg.id)) {
    restartCard(ctx, pkg.name);
  } else {
    try {
      await ctx.plugins.start(pkg.id);
      ctx.notices.toast(`Installed ${pkg.name}.`);
    } catch (e) {
      ctx.notices.card({ tone: 'warn', title: `${pkg.name} was installed, but it didn't start`, body: `${message(e)} You can turn it off or remove it in Settings → Plugins.` });
    }
  }
  ctx.go('#/plugins');
}
