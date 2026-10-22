import { h, messageOf as message } from '../dom.js';
import { bytes } from '../format.js';
import { explainStorageFull } from '../storage-full.js';
import { setPendingPackage } from '../plugin-pending.js';
import { NO_SERVICE } from './plugin-install.js';
import { sayFilled } from '../provider-setup.js';
import { officialPlugins } from '../../core/llm/official.js';
import { addFromCatalog } from '../../core/requires.js';
import { searchCatalog, squash } from '../../core/search.js';
import { CATEGORIES } from '../../core/llm/provider-desc.js';
import { fetchPackage, PLUGIN_MAX_BYTES } from '../../core/packages.js';
import { readZip } from '../../core/zip.js';
import { tracedFetch } from '../../core/agent/net.js';
import { addressParts } from '../../core/address.js';
import { SYS } from '../../core/scopes.js';

/**
 * The Add screen (spec §16.2).
 * @typedef {import('../../core/search.js').SearchEntry & { provides?: Record<string, string[]> }} Facts
 * @typedef {{ facts: Facts, official: boolean, added: number, action: 'add' | 'add-another' | 'install' | 'set-up' | 'open', from: string, href?: string, note?: string }} Row
 *   added: the providers set up from it; from: where it comes from, in words; note: why it can't be added
 * @typedef {import('../../core/search.js').Rank} Rank
 */

/** @type {Record<string, string>} */
const KIND_NAMES = { providers: 'Model providers', speech: 'Voices and transcription', backup: 'Backup places', tools: 'Tools and MCP', skills: 'Skills and personalities', developer: 'Developer' };
/** @type {Record<string, string>} */
const ABILITY_NAMES = { chat: 'Chat', transcription: 'Transcription', voice: 'Voice', realtime: 'Live voice' };
/** Where Add was opened from (?from=), for its crumb; Plugins otherwise. @type {Record<string, [string, string]>} */
const FROM = { models: ['#/models', '← Models'], experimental: ['#/experimental', '← Experimental'] };
const NOT_INSTALLABLE = "That file isn't something annai can install";

/** An MCP server, added on its own screen: a fixed row whose id no manifest can have. @type {Row} */
const MCP_ROW = {
  facts: { id: '#mcp', name: 'An MCP server', version: '', description: 'Tools from a server that speaks MCP, by its address.', category: 'tools',
    keywords: ['MCP', 'Model Context Protocol'], abilities: [], free: false, local: false, code: false, size: 0, requires: [], official: true },
  official: true, added: 0, action: 'set-up', from: 'Built into annai', href: '#/mcp',
};

/** Where a package from elsewhere came from, in words: its address's host, or a file. @param {any} s */
function fromWords(s) {
  if (s.source !== 'url') return 'From a file';
  try {
    return `From ${new URL(s.url).host}`;
  } catch {
    return 'From an address';
  }
}

/**
 * The rows: annai's catalog, what is installed that it doesn't list (built-ins aren't added), and the
 * fixed row. annai's own entry wins over an installed copy of its id, and says why it can't be added
 * (security review); offline, each installed copy is listed as what it is.
 * @param {import('../../core/llm/official.js').CatalogPlugin[] | null} catalog @param {(Facts & { source: string, url?: string, builtin?: boolean })[]} installed
 * @param {Record<string, number>} configured the providers set up, by plugin id @returns {Row[]}
 */
export function addRows(catalog, installed, configured) {
  const mine = new Map(installed.filter((s) => !s.builtin).map((s) => [s.id, s]));
  /** @type {Row[]} */
  const rows = [];
  /** @param {Facts} facts @param {boolean} official @param {any} s its installed record, if any */
  const row = (facts, official, s) => {
    const id = facts.id;
    /** @type {Row} */
    const r = { facts: { ...facts, official }, official, added: configured[id] ?? 0, action: 'install', from: official ? 'Official' : fromWords(s) };
    const type = facts.provides?.['storage-type']?.[0];
    if (official && s && s.source !== 'official') Object.assign(r, { action: 'open', href: `#/plugins/${encodeURIComponent(id)}`, note: `The ${facts.name} installed came from elsewhere but has the id of annai's own, so annai won't use it. Remove it in Settings → Plugins to add annai's.` });
    else if (facts.abilities.length) r.action = r.added ? 'add-another' : 'add';
    else if (facts.category === 'backup') Object.assign(r, { action: 'set-up', href: type ? `#/backups?add=${encodeURIComponent(type)}` : '#/backups' });
    else if (s) Object.assign(r, { action: 'open', href: `#/plugins/${encodeURIComponent(id)}` });
    return r;
  };
  for (const p of catalog ?? []) {
    rows.push(row(p, true, mine.get(p.id)));
    mine.delete(p.id);
  }
  // featured counts only in annai's own catalog.
  for (const s of mine.values()) rows.push(row({ ...s, featured: undefined }, s.source === 'official', s));
  rows.push(MCP_ROW);
  return rows;
}

/**
 * The search box and chips over a list, the Add screen's and the Plugins page's. Typing and tapping
 * draw the list again, never the screen, so the box keeps its focus. A chip shows when it would keep
 * some of the list and not all of it, or when it is on.
 * @template {import('../../core/search.js').SearchEntry} T
 * @param {{ label: string, entries: T[], filters?: import('../../core/search.js').Filters, draw: (found: ({ entry: T } & Rank)[], typed: boolean, filters: import('../../core/search.js').Filters) => (Node | null)[] }} o
 * @returns {{ el: HTMLElement, update: () => void }}
 */
export function finder({ label, entries, filters = {}, draw }) {
  /** @type {Record<string, any>} */
  const f = { ...filters };
  const box = h('input', { type: 'search', 'aria-label': label, placeholder: 'A name, "voice", "free"…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const list = h('div', { class: 'found' });
  /** @type {[HTMLElement, string, any][]} */
  const chips = [];
  /** One filter's value; tapping it again, or another value of that filter, takes it off. @param {string} key @param {any} value @param {string} text */
  const chip = (key, value, text) => {
    const keeps = searchCatalog(entries, '', { [key]: value }).length;
    if (f[key] !== value && (!keeps || keeps === entries.length)) return null;
    const b = h('button', { class: 'chip filter', type: 'button', onclick: () => { f[key] = f[key] === value ? undefined : value; update(); } }, text);
    chips.push([b, key, value]);
    return b;
  };
  const update = () => {
    for (const [b, key, value] of chips) b.setAttribute('aria-pressed', String(f[key] === value));
    list.replaceChildren(...draw(searchCatalog(entries, box.value, f), Boolean(squash(box.value).text), f).filter((n) => n !== null));
  };
  box.addEventListener('input', update);
  const el = h('div', { class: 'finder' }, box,
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Kind' }, ...CATEGORIES.map((k) => chip('kind', k, KIND_NAMES[k]))),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Filters' },
      ...Object.entries(ABILITY_NAMES).map(([a, text]) => chip('ability', a, text)),
      chip('free', true, 'Free'), chip('local', true, 'Local'), chip('source', 'official', 'Official'), chip('source', 'third-party', 'Third-party')),
    list);
  update();
  return { el, update };
}

/** Grouped by kind when nothing is typed, else in the search's order. @template {{ entry: { category: string } }} F @param {F[]} found @param {boolean} typed @param {(x: F) => Node} item */
export function byKind(found, typed, item) {
  if (!found.length) return [h('p', { class: 'empty', text: 'Nothing here matches. Try other words, or take a chip off.' })];
  if (typed) return [h('ul', { class: 'cards' }, ...found.map(item))];
  return CATEGORIES.map((k) => {
    const these = found.filter((x) => x.entry.category === k);
    return these.length ? h('section', { class: 'kind', 'aria-label': KIND_NAMES[k] }, h('h2', { class: 'section', text: KIND_NAMES[k] }), h('ul', { class: 'cards' }, ...these.map(item))) : null;
  });
}

/** Settings → Add: ?kind= and ?ability= open it filtered (spec §16.2). @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderAdd(ctx, route) {
  const { kind, ability, from } = route.params;
  const [back, backText] = Object.hasOwn(FROM, from) ? FROM[from] : ['#/plugins', '← Plugins'];
  const [catalog, installed, cfg] = await Promise.all([officialPlugins().catch(() => null), ctx.plugins.describe(), ctx.llm?.config().catch(() => null)]);
  /** @type {Record<string, number>} */
  const configured = {};
  for (const p of Object.values(cfg?.providers ?? {})) configured[p.plugin] = (configured[p.plugin] ?? 0) + 1;
  const rows = addRows(catalog, installed, configured);
  const byId = new Map(rows.map((r) => [r.facts.id, r]));
  // A provider for any address (catchAll), and the MCP row, come after the ones annai knows, browsing.
  const last = (/** @type {{ entry: Facts }} */ x) => (x.entry.catchAll || x.entry === MCP_ROW.facts ? 1 : 0);
  const redraw = () => view.update(); // after an install, the row it changed
  const view = finder({
    label: 'Search the catalog', entries: rows.map((r) => r.facts), filters: { kind: CATEGORIES.includes(kind) ? kind : undefined, ability: ABILITY_NAMES[ability] ? ability : undefined },
    draw: (found, typed, f) => {
      const item = (/** @type {{ entry: Facts, why?: string }} */ x) => rowItem(ctx, /** @type {Row} */ (byId.get(x.entry.id)), x.why, redraw);
      // Nothing found for model providers, transcription or voices: the user's own server is one such, so Custom provider is offered, by its
      // address. Not on everything with no chip: a skill or a tool searched for and not there is no provider.
      const custom = rows.find((r) => r.facts.catchAll);
      const speechy = f.kind ? f.kind === 'providers' || f.kind === 'speech' : Boolean(f.ability);
      if (typed && !found.length && custom && speechy && searchCatalog([custom.facts], '', { ...f, kind: undefined }).length) {
        return [h('p', { class: 'empty', text: 'Nothing here matches.' }), h('p', { class: 'sub offer', text: 'Not listed? Add it by its address.' }), h('ul', { class: 'cards' }, item({ entry: custom.facts }))];
      }
      return byKind(typed ? found : found.sort((a, b) => last(a) - last(b)), typed, item);
    },
  });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: back }, backText)),
    h('h1', { class: 'title', text: 'Add' }),
    h('p', { class: 'sub', text: "Model providers, voices, backup places, tools and skills: annai's own, and what you have installed." }),
    catalog === null ? h('p', { class: 'sub warn', text: "annai's catalog couldn't be loaded. Connect to the internet and open this screen again. What is installed still shows." }) : null,
    view.el,
    fromElsewhere(ctx));
}

/** One row (spec §16.2), with "Also for" when a keyword matched. @param {any} ctx @param {Row} r @param {string | undefined} why @param {() => void} update */
function rowItem(ctx, r, why, update) {
  const f = r.facts;
  const badges = [...f.abilities.map((a) => ABILITY_NAMES[a] ?? a), f.free ? 'Free' : null, f.local ? 'Local' : null].filter((b) => b !== null);
  return h('li', { class: 'card' },
    h('span', { class: 'name', text: f.name }),
    why ? h('span', { class: 'sub', text: `Also for: ${why}` }) : null,
    badges.length ? h('span', { class: 'chips' }, ...badges.map((b) => h('span', { class: b === 'Free' ? 'chip ok' : 'chip', text: b }))) : null,
    f.description ? h('p', { class: 'sub', text: f.description }) : null,
    h('span', { class: 'sub', text: [r.from, f.version ? (f.code ? 'Has code' : 'Data only') : null, f.size ? bytes(f.size) : null].filter(Boolean).join(' · ') }),
    r.note ? h('p', { class: 'sub warn', text: r.note }) : null,
    h('div', { class: 'acts' }, ...actions(ctx, r, update)));
}

/** A button's work, once at a time: what fails is said on a card, and the button comes back. @param {any} ctx @param {HTMLButtonElement} b @param {string} title @param {() => Promise<void>} work */
async function run(ctx, b, title, work) {
  const label = b.textContent;
  b.disabled = true;
  try {
    await work();
  } catch (e) {
    b.disabled = false;
    b.textContent = label;
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title, body: message(e) });
  }
}

/** What a row's button or link does. @param {any} ctx @param {Row} r @param {() => void} update */
function actions(ctx, r, update) {
  const { id, name } = r.facts;
  if (r.href) {
    const text = r.action === 'open' ? 'Open' : 'Set up';
    return [h('a', { class: 'btn', href: r.href, 'aria-label': `${text} ${name}` }, text)];
  }
  const install = r.action === 'install';
  const label = install ? 'Install' : r.added ? 'Add another' : 'Add';
  const b = h('button', {
    class: install || r.added ? 'btn' : 'btn pri', type: 'button', 'aria-label': `${label} ${name}`,
    onclick: () => run(ctx, b, `${name} wasn't ${install ? 'installed' : 'added'}`, install
      ? async () => {
        if (!navigator.serviceWorker?.controller) throw new Error(NO_SERVICE);
        await addFromCatalog(ctx.plugins, id, { tap: true }); // with what it requires
        ctx.notices.toast(`Installed ${name}.`);
        Object.assign(r, { action: 'open', href: `#/plugins/${encodeURIComponent(id)}` });
        update();
      }
      // A provider: its plugin with what it needs, then the provider and its page (spec §9.8); one with code may
      // have its own Add flow (decision 15), such as a look at what an address offers.
      : async () => {
        b.textContent = 'Adding…';
        // Chat roles still empty get free models only; the speech lists get the rest behind the free entries (spec §9.8).
        /** @type {string[]} */
        const filled = [];
        /** @type {Record<string, string>} */
        const costs = {};
        const o = { official: r.official, filled, costs };
        const added = r.facts.code ? await ctx.llm.startAdd(id, o) : await ctx.llm.addProvider(id, o);
        ctx.go(added === null ? `#/models/provider?new=${encodeURIComponent(id)}` : `#/models/provider?id=${encodeURIComponent(added)}`);
        if (added !== null) sayFilled(ctx, id, filled, costs);
      }),
  }, label);
  return [r.added ? h('span', { class: 'sub', text: 'Added' }) : null, b];
}

/** Installing from an address or a file: the install screen comes first (choice 8 of milestone 8a). @param {any} ctx */
function fromElsewhere(ctx) {
  const input = h('input', {
    id: 'plugin-file', type: 'file', class: 'visually-hidden', accept: '.zip,.md,application/zip,text/markdown',
    onchange: async () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) await fromFile(ctx, f);
    },
  });
  const address = h('input', { id: 'plugin-address', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://…/SKILL.md' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const get = h('button', { class: 'btn', type: 'button', onclick: () => fromAddress(ctx, address.value, get, error) }, 'Get it');
  address.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') get.click(); });
  return h('section', { class: 'panel', 'aria-label': 'Install from an address or a file' },
    h('h2', { class: 'section', text: 'Install from an address or a file' }),
    h('p', { class: 'risk-note', text: "A plugin with code gets full access to your trips and API keys. Data-only plugins can't run anything. Only install plugins you trust." }),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Address of a plugin or skill' }), address),
    h('p', { class: 'sub', text: 'A zip file, an annai-plugin.json, or a SKILL.md, on a site that lets web apps read it (GitHub file pages work).' }),
    error,
    h('div', { class: 'acts' }, get, h('label', { class: 'btn', for: 'plugin-file' }, 'Install from a file'), input));
}

/** A file picked: a zip, or a SKILL.md on its own. @param {any} ctx @param {File} f */
async function fromFile(ctx, f) {
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    /** @type {Map<string, Uint8Array>} */
    let files;
    if (/\.md$/i.test(f.name)) files = new Map([['SKILL.md', bytes]]);
    else {
      try {
        files = await readZip(bytes, { maxTotal: PLUGIN_MAX_BYTES });
      } catch (e) {
        throw new Error(`this file isn't a plugin package annai can open: ${message(e)}`);
      }
    }
    const pkg = await ctx.plugins.inspect(files);
    setPendingPackage({ files, pkg, from: { source: 'file', file: f.name }, back: location.hash });
    ctx.go('#/plugin-install');
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: NOT_INSTALLABLE, body: message(e) });
  }
}

/** The keys an address may hold, or none when it isn't one. @param {string} url */
function keysIn(url) {
  try {
    return addressParts(url).keys;
  } catch {
    return [];
  }
}

/**
 * An address given: the package is fetched (each request in the trace) and checked, then shown.
 * @param {any} ctx @param {string} value @param {HTMLButtonElement} button @param {HTMLElement} error
 */
async function fromAddress(ctx, value, button, error) {
  const url = value.trim();
  error.hidden = true;
  if (!url) {
    error.textContent = 'Paste the address of a zip file, an annai-plugin.json or a SKILL.md first.';
    error.hidden = false;
    return;
  }
  button.disabled = true;
  button.textContent = 'Getting it…';
  try {
    // A key in the address isn't a secret yet: the trace blanks it all the same (fix pass 8a-1).
    const files = await fetchPackage(url, { fetch: tracedFetch(ctx.store, SYS, { tool: 'plugins', blank: keysIn(url) }) });
    const pkg = await ctx.plugins.inspect(files);
    setPendingPackage({ files, pkg, from: { source: 'url', url }, back: location.hash });
    ctx.go('#/plugin-install');
  } catch (e) {
    error.textContent = message(e);
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Get it';
  }
}
