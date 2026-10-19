import { h, messageOf as message } from '../dom.js';
import { bytes } from '../format.js';
import { explainStorageFull } from '../storage-full.js';
import { setPendingPackage } from '../plugin-pending.js';
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
 * @typedef {import('../../core/search.js').SearchEntry & { provides?: Record<string, string[]> }} Facts
 * @typedef {{ facts: Facts, official: boolean, added: number, action: 'add' | 'add-another' | 'install' | 'set-up' | 'open', from: string, href?: string, note?: string }} Row
 *   added: the providers set up from it; from: where it comes from, in words; href: where Set up and Open go; note: why it can't be added
 * @typedef {import('../../core/search.js').Rank} Rank
 */

/** The six kinds, by their names on screen (decision 13 of the provider plan). @type {Record<string, string>} */
export const KIND_NAMES = { providers: 'Model providers', speech: 'Voices and transcription', backup: 'Backup places', tools: 'Tools and MCP', skills: 'Skills and personalities', developer: 'Developer' };
/** @type {Record<string, string>} */
const ABILITY_NAMES = { chat: 'Chat', transcription: 'Transcription', voice: 'Voice' };
/** Another address is the catch-all, so it comes after the providers annai knows when browsing. */
const ANOTHER = 'provider-another-address';
const NOT_INSTALLABLE = "That file isn't something annai can install";

/** An MCP server, added on its own screen: a fixed row whose id no manifest can have. @type {Row} */
const MCP_ROW = {
  facts: { id: '#mcp', name: 'An MCP server', version: '', description: "Tools from a server that speaks MCP (the Model Context Protocol), added by its address.", category: 'tools',
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
 * The Add screen's rows (spec §16.2): annai's catalog, then what is installed that it doesn't list,
 * then the fixed row for an MCP server. annai's own entry wins over an installed copy of its id: a copy
 * from elsewhere is never shown as annai's (security review), and its row says why annai's can't be
 * added. Offline (no catalog), installed items still list, each as what it is. annai's built-in parts
 * aren't something to add.
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
    rows.push(row(/** @type {Facts} */ ({ description: '', keywords: [], abilities: [], ...p }), true, mine.get(p.id)));
    mine.delete(p.id);
  }
  // featured counts only in annai's own catalog (the plan's risk 13).
  for (const s of mine.values()) rows.push(row({ ...s, featured: undefined }, s.source === 'official', s));
  rows.push(MCP_ROW);
  return rows;
}

/**
 * The search box and chips over a list: the Add screen's and the Plugins page's. Typing and tapping
 * draw the list again, never the screen, so the box keeps its focus. A chip shows when it would keep
 * some of the list and not all of it, or when it is on (the screen may open with one on).
 * @template {import('../../core/search.js').SearchEntry} T
 * @param {{ label: string, entries: T[], filters?: import('../../core/search.js').Filters, draw: (found: ({ entry: T } & Rank)[], typed: boolean) => (Node | null)[] }} o
 * @returns {{ el: HTMLElement, update: () => void }}
 */
export function finder({ label, entries, filters = {}, draw }) {
  /** @type {Record<string, any>} */
  const f = { ...filters };
  const box = h('input', { type: 'search', 'aria-label': label, placeholder: 'A name, "voice", "free"…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const list = h('div', { class: 'found' });
  /** @type {[HTMLElement, string, any][]} */
  const chips = [];
  /** A chip for one filter's value; tapping it again, or another value of that filter, takes it off. @param {string} key @param {any} value @param {string} text */
  const chip = (key, value, text) => {
    const keeps = searchCatalog(entries, '', { [key]: value }).length;
    if (f[key] !== value && (!keeps || keeps === entries.length)) return null;
    const b = h('button', { class: 'chip filter', type: 'button', onclick: () => { f[key] = f[key] === value ? undefined : value; update(); } }, text);
    chips.push([b, key, value]);
    return b;
  };
  const update = () => {
    for (const [b, key, value] of chips) b.setAttribute('aria-pressed', String(f[key] === value));
    list.replaceChildren(...draw(searchCatalog(entries, box.value, f), Boolean(squash(box.value).text)).filter((n) => n !== null));
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

/**
 * What was found, grouped by kind when nothing is typed (only kinds with something in them), else in
 * the search's order; or words for nothing.
 * @template {{ entry: { category: string } }} F @param {F[]} found @param {boolean} typed @param {(x: F) => Node} item
 */
export function byKind(found, typed, item) {
  if (!found.length) return [h('p', { class: 'empty', text: 'Nothing here matches. Try other words, or take a chip off.' })];
  if (typed) return [h('ul', { class: 'cards' }, ...found.map(item))];
  return CATEGORIES.map((k) => {
    const these = found.filter((x) => x.entry.category === k);
    return these.length ? h('section', { class: 'kind', 'aria-label': KIND_NAMES[k] }, h('h2', { class: 'section', text: KIND_NAMES[k] }), h('ul', { class: 'cards' }, ...these.map(item))) : null;
  });
}

/**
 * Settings → Add (spec §16.2): one screen for everything a user can add, searchable and browsable.
 * Models → Add a provider opens it on model providers (?kind=providers), a speech role's Add on what
 * has its ability (?ability=transcription or voice), and Plugins → Add on everything.
 * @param {any} ctx @param {{ params: Record<string, string> }} route
 */
export async function renderAdd(ctx, route) {
  const { kind, ability } = route.params;
  const [catalog, installed, cfg] = await Promise.all([officialPlugins().catch(() => null), ctx.plugins.describe(), ctx.llm?.config().catch(() => null)]);
  /** @type {Record<string, number>} */
  const configured = {};
  for (const p of Object.values(cfg?.providers ?? {})) configured[p.plugin] = (configured[p.plugin] ?? 0) + 1;
  const rows = addRows(catalog, installed, configured);
  const byId = new Map(rows.map((r) => [r.facts.id, r]));
  // Browsing, the catch-alls come last in their kind: Another address, and an MCP server.
  const last = (/** @type {{ entry: Facts }} */ x) => (x.entry.id === ANOTHER || x.entry.id === MCP_ROW.facts.id ? 1 : 0);
  const redraw = () => view.update(); // after an install, the row it changed
  const view = finder({
    label: 'Search the catalog', entries: rows.map((r) => r.facts), filters: { kind: CATEGORIES.includes(kind) ? kind : undefined, ability: ABILITY_NAMES[ability] ? ability : undefined },
    draw: (found, typed) => byKind(typed ? found : found.sort((a, b) => last(a) - last(b)), typed, (x) => rowItem(ctx, /** @type {Row} */ (byId.get(x.entry.id)), x.why, redraw)),
  });
  const models = Boolean(kind || ability);
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: models ? '#/models' : '#/plugins' }, models ? '← Models' : '← Plugins')),
    h('h1', { class: 'title', text: 'Add' }),
    h('p', { class: 'sub', text: "Model providers, voices, backup places, tools and skills: annai's own, and what you have installed." }),
    catalog === null ? h('p', { class: 'sub warn', text: "annai's catalog couldn't be loaded. Connect to the internet and open this screen again. What is installed still shows." }) : null,
    view.el,
    fromElsewhere(ctx));
}

/**
 * One row: its name, why it matched when it was a keyword, its abilities, free and local, where it
 * comes from, data only or code, its size, and what can be done with it.
 * @param {any} ctx @param {Row} r @param {string | undefined} why @param {() => void} update
 */
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

/** What a row's button or link does. @param {any} ctx @param {Row} r @param {() => void} update */
function actions(ctx, r, update) {
  const name = r.facts.name;
  if (r.action === 'set-up' || r.action === 'open') {
    const text = r.action === 'open' ? 'Open' : 'Set up';
    return [h('a', { class: 'btn', href: r.href, 'aria-label': `${text} ${name}` }, text)];
  }
  if (r.action === 'install') {
    return [h('button', {
      class: 'btn', type: 'button', 'aria-label': `Install ${name}`,
      onclick: async (/** @type {Event} */ e) => {
        const b = /** @type {HTMLButtonElement} */ (e.currentTarget);
        b.disabled = true;
        try {
          if (!navigator.serviceWorker?.controller) throw new Error("Plugins load through annai's offline service, which isn't running yet. Reload annai and try again.");
          await addFromCatalog(ctx.plugins, r.facts.id, { tap: true }); // with what it requires
          ctx.notices.toast(`Installed ${name}.`);
          Object.assign(r, { action: 'open', href: `#/plugins/${encodeURIComponent(r.facts.id)}` });
          update();
        } catch (err) {
          b.disabled = false;
          if (!explainStorageFull(ctx, err)) ctx.notices.card({ tone: 'warn', title: `${name} wasn't installed`, body: message(err) });
        }
      },
    }, 'Install')];
  }
  // A provider: its plugin with what it needs, then the provider, then its page (spec §9.8).
  const label = r.action === 'add-another' ? 'Add another' : 'Add';
  const add = h('button', {
    class: r.added ? 'btn' : 'btn pri', type: 'button', 'aria-label': `${label} ${name}`,
    onclick: async () => {
      add.disabled = true;
      add.textContent = 'Adding…';
      try {
        const id = await ctx.llm.addProvider(r.facts.id, { roles: 'recommended', official: r.official });
        ctx.go(`#/models/provider?id=${encodeURIComponent(id)}`);
      } catch (err) {
        add.disabled = false;
        add.textContent = label;
        if (!explainStorageFull(ctx, err)) ctx.notices.card({ tone: 'warn', title: `${name} wasn't added`, body: message(err) });
      }
    },
  }, label);
  return [r.added ? h('span', { class: 'sub', text: 'Added' }) : null, add];
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
    setPendingPackage({ files, pkg, from: { source: 'file', file: f.name } });
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
    setPendingPackage({ files, pkg, from: { source: 'url', url } });
    ctx.go('#/plugin-install');
  } catch (e) {
    error.textContent = message(e);
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Get it';
  }
}
