import { h, crumb, t } from '../dom.js';
import { SOURCES, FONTS, ART } from '../credits.js';
import { keysAndData, finePrint, REPO } from '../privacy.js';

/**
 * Settings → About (the user, 2026-10-18): annai, its version and the build that is running (Updates is a
 * tap away), its licence and source, where to report a problem, what it does with keys and data (the welcome's
 * words), the fine print, the welcome again, and the credits. #/about/licence and #/about/fonts show
 * the licence texts annai ships, so they read offline.
 * @typedef {import('../credits.js').Link} Link
 */

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);
/** @param {Link} l */
const out = (l) => h('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer', text: l.text });

/** A credit's words with each link where the words say it, and the rest after. @param {string} text @param {Link[]} links */
export function linked(text, links) {
  const at = links.map((l) => ({ l, i: text.indexOf(l.text) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
  /** @type {any[]} */
  const parts = [];
  let from = 0;
  /** @type {Link[]} */
  const used = [];
  for (const { l, i } of at) {
    if (i < from) continue;
    parts.push(text.slice(from, i), out(l));
    used.push(l);
    from = i + l.text.length;
  }
  parts.push(text.slice(from));
  for (const l of links) if (!used.includes(l)) parts.push(' ', out(l));
  return parts;
}

/**
 * The build of the service worker that runs annai now (sw.js answers "build" on a port), or null
 * before one controls the page, or when it doesn't answer within a moment.
 * @param {number} [ms] @returns {Promise<string | null>}
 */
export function runningBuild(ms = 2000) {
  const c = navigator.serviceWorker?.controller;
  if (!c) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const t = setTimeout(() => resolve(null), ms);
    channel.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(typeof e.data?.build === 'string' ? e.data.build : null);
    };
    c.postMessage('build', [channel.port2]);
  });
}

/** "annai 0.1.0 · build …", drawn at once; the build fills in when the service worker answers, or once one runs annai. @param {string} v */
export function versionLine(v) {
  const version = h('p', { class: 'version', text: `annai ${v}` });
  const ask = () => runningBuild().then((build) => {
    version.textContent = build ? `annai ${v} · build ${build}` : `annai ${v} · build not known yet: annai's offline service is still starting`;
    if (!build) navigator.serviceWorker?.addEventListener('controllerchange', () => { if (version.isConnected) ask(); }, { once: true });
  }).catch(() => {}); // the version alone stays
  ask();
  return version;
}

/** @param {any} ctx @param {{ parts: string[] }} route */
export async function renderAbout(ctx, route) {
  if (route.parts[1] === 'licence') {
    return licenceText('GNU Affero General Public License', "annai's licence, version 3, as annai ships it.", '/LICENSE', `${REPO}/blob/main/LICENSE`);
  }
  if (route.parts[1] === 'fonts') {
    return licenceText('Font licences', `${FONTS.map((f) => f.name).join(', ').replace(/, ([^,]*)$/, ' and $1')}, under the SIL Open Font License 1.1, as annai ships them.`, '/assets/fonts/OFL.txt', `${REPO}/blob/main/assets/fonts/OFL.txt`);
  }
  return h('div', { class: 'screen about' },
    h('p', { class: 'crumbs' }, crumb('#/settings', t`Settings`)),
    h('h1', { class: 'title', text: 'About annai' }),
    versionLine(ctx.version),
    h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/updates' }, 'Check for updates')),
    h('p', { class: 'sub', text: 'annai (案内) is Japanese for "guidance; showing someone around". It is a free, open-source travel guide, and its guide is Shiori.' }),
    section('Licence and source',
      h('p', { text: 'annai is free software under the GNU Affero General Public License, version 3 (AGPL-3.0). You may use it, study it, share it and change it. Anyone who runs a changed copy for others must offer them its source too.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/about/licence' }, 'Read the licence')),
      h('p', {}, 'The source: ', out({ href: REPO, text: 'github.com/annai-guide/annai' }), '.')),
    section('Report a problem',
      h('p', {}, 'Tell us on GitHub, at ', out({ href: `${REPO}/issues`, text: 'github.com/annai-guide/annai/issues' }), '.'),
      h('p', { class: 'sub', text: 'Settings → Diagnostics copies a report of recent errors and system events, without your files or keys, to paste there.' })),
    section('Your keys and your data', ...keysAndData('h3')),
    section('The fine print', ...finePrint()),
    section('The welcome',
      h('p', { class: 'sub', text: 'The few screens annai showed when it first opened here.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/welcome' }, 'Show the welcome again'))),
    section('Credits',
      h('p', { class: 'sub', text: 'Where Shiori looks things up, and the credit each source asks for.' }),
      ...SOURCES.map((s) => h('div', { class: 'credit' },
        h('h3', { class: 'credit-name', text: s.name }),
        h('p', { class: 'sub', text: s.use }),
        h('p', {}, ...linked(s.credit, s.links)))),
      h('div', { class: 'credit' },
        h('h3', { class: 'credit-name', text: 'Fonts' }),
        h('p', { text: `${FONTS.map((f) => `${f.name} (${f.copyright.replace(/^Copyright (© )?/, '© ')})`).join('; ')}: each under the SIL Open Font License 1.1.` }),
        h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/about/fonts' }, 'Read the font licences'))),
      h('div', { class: 'credit' },
        h('h3', { class: 'credit-name', text: 'Shiori' }),
        h('p', { text: ART }))));
}

/** A licence text annai ships, read in annai. @param {string} title @param {string} note @param {string} path @param {string} online */
async function licenceText(title, note, path, online) {
  /** @type {string | null} */
  let text = null;
  try {
    const res = await fetch(path);
    if (res.ok) text = await res.text();
  } catch {
    // not here yet (offline before the first install): the address online instead
  }
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/about', t`About annai`)),
    h('h1', { class: 'title', text: title }),
    h('p', { class: 'sub', text: note }),
    text === null
      ? h('p', {}, "The text couldn't be loaded here. It is also at ", out({ href: online, text: online.replace(/^https:\/\//, '') }), '.')
      : h('pre', { class: 'licence-text', text }));
}
