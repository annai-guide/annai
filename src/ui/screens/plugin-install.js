import { h } from '../dom.js';
import { pendingPackage, setPendingPackage } from '../plugin-pending.js';
import { explainStorageFull } from '../storage-full.js';
import { traceUrl } from '../../core/agent/net.js';
import { addsAnything } from '../../core/packages.js';

/** The spec's own words for a package with code (§5.1). */
export const FULL_ACCESS = 'This plugin gets full access to your trips and API keys.';
const message = (/** @type {any} */ e) => String(e?.message ?? e);

/** What a package brings, one line each (choice 8 of milestone 8a). @param {{ code: boolean, skills: any[], personalities: any[], templates: any[] }} pkg @returns {string[]} */
export function whatItBrings(pkg) {
  const out = [];
  if (pkg.code) out.push('Code that runs in annai');
  for (const s of pkg.skills ?? []) out.push(`Skill "${s.name}": ${s.description}`);
  for (const p of pkg.personalities ?? []) out.push(`Personality "${p.name}"`);
  if (pkg.templates?.length) out.push(`Endpoint templates: ${pkg.templates.map((t) => t.name).join(', ')}`);
  return out.length ? out : ['Nothing annai uses yet'];
}

/**
 * Where a package came from, in words: its address as the trace keeps it (no key in it), a file, or annai.
 * @param {{ source?: string, url?: string, file?: string }} from
 */
export function sourceLine(from) {
  if (from?.source === 'url' && from.url) {
    const kept = traceUrl(from.url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
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
    actions: [{ label: 'Restart annai', primary: true, run: () => location.reload() }],
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
  const what = pkg.kind === 'skill' ? 'A skill' : pkg.code ? 'A plugin' : 'A package without code';
  const line = [what, pkg.shownVersion ? `version ${pkg.shownVersion}` : null, pkg.author ? `by ${pkg.author}` : null].filter(Boolean).join(' · ');
  const home = webAddress(pkg.homepage);
  const install = h('button', { class: 'btn pri', type: 'button', onclick: () => installPending(ctx, install) }, 'Install');
  return h('div', { class: 'screen plugin-install' }, back,
    h('h1', { class: 'title', text: `Install ${pkg.name}?` }),
    h('p', { class: 'sub', text: line }),
    home ? h('p', {}, h('a', { href: home, target: '_blank', rel: 'noopener noreferrer', text: home })) : null,
    pkg.description ? h('p', { text: pkg.description }) : null,
    h('p', { class: 'sub', text: sourceLine(from) }),
    h('section', { class: 'panel', 'aria-label': 'What it brings' },
      h('h2', { class: 'section', text: 'What it brings' }),
      h('ul', { class: 'brings' }, ...whatItBrings(pkg).map((t) => h('li', { text: t })))),
    pkg.code
      ? h('div', { class: 'risk-note', role: 'note' }, h('p', { text: FULL_ACCESS }), h('p', { text: 'Only install it if you trust where it came from.' }))
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
    if (pkg.code && !navigator.serviceWorker?.controller) {
      throw new Error("Plugins load through annai's offline service, which isn't running yet. Reload annai and try again.");
    }
    await ctx.plugins.install(p.files, p.from);
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: `${pkg.name} wasn't installed`, body: message(e) });
    button.disabled = false;
    return;
  }
  setPendingPackage(null);
  if (ctx.plugins.needsRestart(pkg.id)) {
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
