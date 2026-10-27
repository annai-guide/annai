import { h, crumb, t, tc, linkIn, messageOf as message } from '../dom.js';
import { list, sentences } from '../format.js';
import { pendingPackage, setPendingPackage } from '../plugin-pending.js';
import { explainStorageFull } from '../storage-full.js';
import { addressParts } from '../../core/address.js';
import { addsAnything } from '../../core/packages.js';
import { descOrigins } from '../../core/llm/provider-desc.js';
import { officialPlugins } from '../../core/llm/official.js';
import { checkRequires, installWith, checkPackageId } from '../../core/requires.js';
import { NAMED } from '../../core/registry.js';
import { readConfig, providerOf } from '../../core/llm/config.js';
import { listTargets } from '../../core/backup-targets.js';

/** The spec's own words for a package with code (§5.1). */
export const FULL_ACCESS = t`This plugin gets full access to your trips and API keys.`;
/**
 * Whose keys annai keeps now, by name only, never a value (fixes-ui 15): providers', backup places', MCP servers',
 * Jina's and plugins' own. ids: only these keys (secret ids), else all. A key whose owner is gone has no name, and is left out.
 * @param {any} plugins the plugin host @param {string[]} [only] @returns {Promise<string[]>}
 */
export async function keyNames(plugins, only) {
  const ws = plugins.ws;
  const ids = only ?? /** @type {string[]} */ (await ws.store.tx(['secrets'], 'readonly', (/** @type {any} */ tx) => tx.listSecretIds()).catch(() => []));
  const providers = (await readConfig(ws).catch(() => null))?.providers ?? {};
  const places = await listTargets(ws).catch(() => []);
  const rows = await plugins.describe().catch(() => []);
  /** @type {Set<string>} */
  const names = new Set();
  for (const id of ids) {
    const [kind, of, ...rest] = id.split(':');
    const rec = kind === 'llm' ? providers[id.slice(4)] : null;
    const name = rec ? providerOf(rec).name
      : kind === 'backup' ? places.find((/** @type {any} */ p) => p.id === id.slice(7))?.name
        : kind !== 'plugin' ? null : of === 'mcp' ? rest.join(':') : id === 'plugin:web:jina' ? /* en */ 'Jina' : rows.find((/** @type {any} */ r) => r.id === of)?.name;
    if (name) names.add(String(name));
  }
  return [...names];
}

/** What a code plugin that isn't annai's own can do with them, in plain words. @param {string[]} names keyNames() */
export const keysRisk = (names) => (names.length ? t`It can read every key saved in annai and send it anywhere: now your keys for ${list(names)}.`
  : t`It can read every key saved in annai and send it anywhere.`);

/** A plugin's code loads through the service worker (spec §5.3). */
export const NO_SERVICE = t`Plugins load through annai's offline service, which isn't running yet. Reload annai and try again.`;

/** Items side by side with a semicolon, as this language writes one: for items that hold commas. @param {string[]} items */
export const semicolons = (items) => (items.length ? items.reduce((a, b) => tc('semicolons')`${a}; ${b}`) : '');

/**
 * What a package brings, one line each (choice 8 of milestone 8a): its code, skills, personalities,
 * its model provider, and (in an update) the new origins its provider sends keys to. A skill's name and description are its own words.
 * @param {{ code: boolean, skills: any[], personalities: any[], provider?: any, search?: any, origins?: string[], searchOrigins?: string[] }} pkg @returns {string[]}
 */
export function whatItBrings(pkg) {
  const out = [];
  if (pkg.code) out.push(t`Code that runs in annai`);
  for (const s of pkg.skills ?? []) out.push(t`Skill "${s.name}": ${s.description}`);
  for (const p of pkg.personalities ?? []) out.push(t`Personality "${p.name}"`);
  if (pkg.provider) out.push(t`A model provider: ${abilityWords(pkg.provider)}`);
  if (pkg.search) out.push(t`A search provider for web_search`);
  const searches = pkg.searchOrigins ?? [];
  const keys = (pkg.origins ?? []).filter((o) => !searches.includes(o));
  if (keys.length) out.push(t`Its provider now sends keys you give it to ${list(keys, 'plain')}`);
  if (searches.length) out.push(t`Its searches now go to ${list(searches, 'plain')}`);
  return out.length ? out : [t`Nothing annai uses yet`];
}


/**
 * Where a provider sends the keys a user gives it, by origin with its scheme (security review): said on
 * a fresh install as on an update; a search provider's, where its searches go. null for a package that is neither.
 * @param {{ provider?: any, search?: any }} pkg @returns {string | null}
 */
export function keysNote(pkg) {
  /** @type {string[]} */
  const out = [];
  if (pkg.provider) {
    const origins = descOrigins(pkg.provider);
    out.push(origins.length ? t`Keys you give this provider are sent to ${list(origins)}.` : t`Keys you give this provider are sent only to the address you give it.`);
  }
  if (pkg.search) {
    const o = [...(pkg.search.origins ?? [])].sort();
    out.push(!o.length ? t`Your search words are sent only to the address you give it.`
      : pkg.search.key && !pkg.provider ? t`Your search words and the key you give it are sent to ${list(o)}.` : t`Your search words are sent to ${list(o)}.`);
  }
  return out.length ? sentences(...out) : null;
}

/** Where to get a search plugin's key and its free-tier line (its manifest's search.key), or null. @param {{ search?: any }} pkg @returns {{ text: string, url: string } | null} */
export function searchKeyInfo(pkg) {
  const k = pkg.search?.key;
  return k && (k.url || k.note) ? { text: String(k.note ?? ''), url: String(k.url ?? '') } : null;
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
    const each = requires.map((r) => (plan.some((e) => e.id === r.id) ? t`${plan.find((e) => e.id === r.id)?.name} (from annai, installed with it)` : t`${state[r.id]?.name ?? r.id} (installed)`));
    return { ok: true, text: t`It needs: ${semicolons(each)}.` };
  } catch (e) {
    return { ok: false, text: catalog ? message(e) : t`annai's catalog couldn't be loaded to look for what it needs. Connect to the internet and try again.` };
  }
}

/** A provider's abilities' kinds, in words. @type {Record<string, string>} */
const ABILITY_WORDS = { chat: t`chat`, transcription: t`transcription`, voice: t`voice`, realtime: t`realtime` };
/** A provider's abilities in words: "chat, transcription and voice". @param {any} desc */
export function abilityWords(desc) {
  const kinds = [...new Set(Object.values(desc?.abilities ?? {}).map((/** @type {any} */ a) => String(a?.kind)))];
  return list(kinds.map((k) => ABILITY_WORDS[k] ?? k)) || t`nothing yet`;
}

/**
 * Where a package came from (fix pass 8a-1): its address as annai keeps it, with «key» for each key in it and without its
 * scheme; or none, for one from a file or annai, or an address that can't be read.
 * @param {{ source?: string, url?: string, file?: string }} from @returns {string | null}
 */
export function sourceHost(from) {
  if (from?.source !== 'url' || !from.url) return null;
  let kept = '';
  try {
    kept = addressParts(from.url).shown.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  } catch {
    return null;
  }
  try {
    return decodeURI(kept);
  } catch {
    return kept; // keep the escapes
  }
}

/** Where a package came from, as its kind of place: an address, a file (by name), or annai. @param {{ source?: string, url?: string, file?: string }} from */
function placeOf(from) {
  const host = sourceHost(from);
  if (host) return { kind: 'host', value: host };
  if (from?.source === 'url' && from.url) return { kind: 'address', value: '' };
  if (from?.source === 'file') return from.file ? { kind: 'named file', value: from.file } : { kind: 'file', value: '' };
  return { kind: 'annai', value: '' };
}

/** Where a package came from, in words. @param {{ source?: string, url?: string, file?: string }} from */
export function sourceLine(from) {
  const { kind, value } = placeOf(from);
  if (kind === 'host') return t`From ${value}`;
  if (kind === 'address') return t`From an address`;
  if (kind === 'named file') return t`From a file: ${value}`;
  return kind === 'file' ? t`From a file` : t`From annai`;
}

/** Whether two packages came from one place: one address (its keys aside), or files. @param {any} a @param {any} b */
const samePlace = (a, b) => a?.source === b?.source && (b?.source !== 'url' || sourceHost(a) === sourceHost(b));

/**
 * Installing over the installed package of its id: an update from where it came, or one from another place.
 * @param {{ version: string, from: { source?: string, url?: string, file?: string } }} previous @param {{ source?: string, url?: string, file?: string }} from
 */
export function overLine(previous, from) {
  const v = previous.version;
  if (samePlace(previous.from, from)) return t`Version ${v} is installed now. Installing replaces it.`;
  const { kind, value } = placeOf(previous.from);
  const now = kind === 'host' ? t`Version ${v} is installed now, from ${value}, not where this one comes from.`
    : kind === 'address' ? t`Version ${v} is installed now, from an address, not where this one comes from.`
      : kind === 'named file' ? t`Version ${v} is installed now, from a file: ${value}, not where this one comes from.`
        : kind === 'file' ? t`Version ${v} is installed now, from a file, not where this one comes from.` : t`Version ${v} is installed now, from annai, not where this one comes from.`;
  return sentences(now, t`Kept, its settings, keys and your choices for its names go to this one; fresh, they are removed.`);
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

/**
 * A named thing in words, "the tool weather", "how Shiori looks", and as it starts a sentence, "The tool weather": a noun with its name,
 * which the sentences about names hold as a value.
 * @type {Record<string, [(name: string) => string, (name: string) => string]>}
 */
const KIND_WORDS = {
  tool: [(n) => t`the tool ${n}`, (n) => t`The tool ${n}`], 'endpoint-type': [(n) => t`the protocol ${n}`, (n) => t`The protocol ${n}`],
  'storage-type': [(n) => t`the kind of backup place ${n}`, (n) => t`The kind of backup place ${n}`], skill: [(n) => t`the skill ${n}`, (n) => t`The skill ${n}`],
  personality: [(n) => t`the personality ${n}`, (n) => t`The personality ${n}`], 'ui:card-type': [(n) => t`the card type ${n}`, (n) => t`The card type ${n}`],
  search: [(n) => t`the search provider ${n}`, (n) => t`The search provider ${n}`],
};
/** @type {Record<string, [string, string]>} */
const COMPONENT_WORDS = {
  avatar: [t`how Shiori looks`, t`How Shiori looks`], dock: [t`the dock`, t`The dock`], 'now-card': [t`the Now card`, t`The Now card`], 'plan-row': [t`how the plan's rows look`, t`How the plan's rows look`],
};
/** @param {string} kind @param {string} name @param {boolean} [first] as it starts a sentence */
export function thingWords(kind, name, first = false) {
  const at = first ? 1 : 0;
  if (kind === 'ui:component') return COMPONENT_WORDS[name]?.[at] ?? (first ? t`The part ${name}` : t`the part ${name}`);
  return KIND_WORDS[kind]?.[at](name) ?? `${kind} ${name}`;
}
/** Who owns a name: annai, a built-in's or official plugin's name, else a name from a manifest, with its id. @param {any[]} rows describe()'s @param {string} id */
export function ownerName(rows, id) {
  const r = id === 'annai' ? null : rows.find((x) => x.id === id);
  return !r ? id : r.builtin || r.source === 'official' ? r.name : `${r.name} (${id})`;
}

/** What a package's replaces would replace now, and the user may choose. @param {any} ctx @param {{ id: string, replaces?: string[] }} pkg @returns {{ kind: string, name: string, owner: string }[]} */
export function replacing(ctx, pkg) {
  return (pkg.replaces ?? []).flatMap((name) => Object.keys(NAMED).map((kind) => ({ kind, name, owner: ctx.registry.owner(kind, name)?.pluginId })))
    .filter((r) => r.owner && r.owner !== pkg.id && ctx.registry.choosable(r.kind, r.name));
}

/** The card that says annai must start again to run new code. @param {any} ctx @param {string} name */
export function restartCard(ctx, name) {
  ctx.notices.card({
    title: t`Restart annai to run the new version of ${name}.`, body: t`The browser keeps the old code until annai starts again.`,
    actions: [{ label: t`Restart annai`, primary: true, run: () => ctx.updates?.restart() ?? location.reload() }], // after Shiori's turn (Updates.restart)
  });
}

/**
 * What a package is, its version and who made it, in a line: "A model provider · has code · version 1.2.0 · by Tides Co".
 * @param {{ builtin?: boolean, kind?: string, provider?: any, code?: boolean, shownVersion?: string, author?: string }} p a package, or an installed one's row
 */
export function packageLine(p) {
  const what = p.builtin ? t`Built into annai` : p.kind === 'skill' ? t`A skill` : p.provider ? (p.code ? t`A model provider · has code` : t`A model provider · data only`)
    : p.code ? t`A plugin` : t`A package without code`;
  return [what, p.shownVersion ? t`version ${p.shownVersion}` : null, p.author ? t`by ${p.author}` : null].filter(Boolean).join(' · ');
}

/**
 * The install screen (spec §5.1, choice 8): what the package is, where it came from, what it brings
 * and may do, before anything is stored.
 * @param {any} ctx
 */
export async function renderPluginInstall(ctx) {
  const p = pendingPackage();
  // Back to the Add screen it was picked on, where installing from a file or an address starts.
  const to = p?.back ?? '#/add';
  const back = h('p', { class: 'crumbs' }, crumb(to, t`Add`));
  if (!p) {
    const again = t`Go back to Add.`;
    return h('div', { class: 'screen' }, back, h('h1', { class: 'title', text: t`Nothing to install` }),
      h('p', {}, ...linkIn(sentences(t`There's nothing to install.`, again), h('a', { href: to, text: again }))));
  }
  const { pkg, from } = p;
  const line = packageLine(pkg);
  const home = webAddress(pkg.homepage);
  const needs = await needsOf(ctx, pkg);
  // A package from elsewhere can't take the name of annai's own plugin (security review).
  const taken = await checkPackageId(ctx.plugins, pkg.id, from?.source).then(() => null, (e) => message(e));
  // What it replaces is chosen here, by a tap.
  const rows = await ctx.plugins.describe();
  const mine = replacing(ctx, pkg);
  const owners = [...new Set(mine.map((s) => s.owner))];
  // Over one from another place: keep what it keeps, or start fresh.
  const elsewhere = Boolean(pkg.previous && !samePlace(pkg.previous.from, from));
  // Code that isn't annai's own (here, from a file or an address): what it can do with the keys saved now, by name (fixes-ui 15).
  const risk = pkg.code ? keysRisk(await keyNames(ctx.plugins)) : null;
  /** @type {[string, { use?: typeof mine, fresh?: boolean }][]} */
  // With the risk said, every way to install says "anyway" (review S4): "Install anyway, keep its settings and keys", "Install fresh anyway".
  const picks = elsewhere ? [[risk ? t`Install anyway, keep its settings and keys` : t`Install, keep its settings and keys`, {}], [risk ? t`Install fresh anyway` : t`Install fresh`, { fresh: true }]]
    : mine.length ? [[risk ? t`Install anyway and use it` : t`Install and use it`, { use: mine }],
      [owners.join() === 'annai' ? (risk ? t`Install anyway, keep annai's` : t`Install, keep annai's`) : (risk ? t`Install anyway, keep what's used now` : t`Install, keep what's used now`), {}]]
      : [[risk ? t`Install anyway` : t`Install`, {}]];
  /** @type {HTMLButtonElement[]} */
  const buttons = picks.map(([label, o], i) => h('button', { class: i ? 'btn' : /* en */ 'btn pri', type: 'button', disabled: !needs.ok || Boolean(taken), onclick: () => installPending(ctx, buttons, /** @type {any} */ (o)) }, /** @type {string} */ (label)));
  return h('div', { class: 'screen plugin-install' }, back,
    h('h1', { class: 'title', text: t`Install ${pkg.name}?` }),
    h('p', { class: 'sub', text: line }),
    home ? h('p', {}, h('a', { href: home, target: '_blank', rel: 'noopener noreferrer', text: home })) : null,
    pkg.description ? h('p', { text: pkg.description }) : null,
    h('p', { class: 'sub', text: sourceLine(from) }),
    taken ? h('p', { class: 'error', role: 'alert', text: taken }) : null,
    h('section', { class: 'panel', 'aria-label': t`What it brings` },
      h('h2', { class: 'section', text: t`What it brings` }),
      h('ul', { class: 'brings' }, ...whatItBrings(pkg).map((w) => h('li', { text: w }))),
      needs.text ? h('p', { class: needs.ok ? 'sub' : 'error', text: needs.text }) : null),
    mine.length ? h('section', { class: 'panel', 'aria-label': t`What it replaces` },
      h('h2', { class: 'section', text: t`What it replaces` }),
      h('ul', { class: 'brings' }, ...mine.map((s) => h('li', { text: t`It replaces ${thingWords(s.kind, s.name)} from ${ownerName(rows, s.owner)}.` })))) : null,
    pkg.code
      ? h('div', { class: 'risk-note', role: 'note' }, h('p', { text: FULL_ACCESS }), risk ? h('p', { text: risk }) : null, h('p', { text: t`Only install it if you trust where it came from.` }), keysNote(pkg) ? h('p', { text: keysNote(pkg) }) : null)
      : pkg.provider
        // A provider's own note, in place of the skill note (security review): what it can't do, and where keys go.
        ? h('div', { class: 'skill-note', role: 'note' }, h('p', { text: t`It can't run anything: it is data that tells annai how to reach a model provider.` }), h('p', { text: keysNote(pkg) }))
        : h('p', { class: 'skill-note', text: t`A skill is instructions for Shiori: she reads them when they fit what you ask, and follows what they say. annai never runs anything in it, so install skills you trust.` }),
    // A search plugin's free-tier line is its own words (L7's); the link is annai's.
    searchKeyInfo(pkg) ? h('p', { class: 'sub' }, `${searchKeyInfo(pkg)?.text ?? ''} `, searchKeyInfo(pkg)?.url ? h('a', { href: searchKeyInfo(pkg)?.url, target: '_blank', rel: 'noopener noreferrer', text: t`Get a key` }) : null) : null,
    pkg.previous ? h('p', { class: elsewhere ? 'risk-note' : 'sub', text: overLine(pkg.previous, from) }) : null,
    // What a new version adds is said on its own, so nothing new slips in with an update (the coordinator's second finding).
    pkg.previous && addsAnything(pkg.previous.added) ? h('section', { class: 'panel', 'aria-label': t`New in this version` },
      h('h2', { class: 'section', text: t`New in this version` }),
      h('ul', { class: 'brings' }, ...whatItBrings(pkg.previous.added).map((w) => h('li', { text: w })))) : null,
    h('div', { class: 'acts' }, ...buttons,
      h('button', { class: 'btn', type: 'button', onclick: () => { setPendingPackage(null); ctx.go(to); } }, t`Cancel`)));
}

/**
 * Installs the package on screen, then starts it; each step that fails says so. use: the names it replaces that the
 * user chose it for; fresh: what the installed one keeps goes first. Both before it starts.
 * @param {any} ctx @param {HTMLButtonElement[]} buttons @param {{ use?: { kind: string, name: string }[], fresh?: boolean }} o
 */
async function installPending(ctx, buttons, { use = [], fresh = false }) {
  const p = pendingPackage();
  if (!p) return;
  const { pkg } = p;
  const choose = async () => { for (const s of use) await ctx.plugins.choose(s.kind, s.name, pkg.id); };
  buttons.forEach((b) => { b.disabled = true; });
  try {
    if (fresh) await ctx.plugins.forgetKept(pkg.id);
    // What it needs (annai's own, from its catalog) may be code too.
    if ((pkg.code || pkg.requires?.length) && !navigator.serviceWorker?.controller) {
      throw new Error(NO_SERVICE);
    }
    if (pkg.requires?.length) {
      // With what it requires, all or nothing, and started (spec §5.3).
      await installWith(ctx.plugins, p.files, p.from, { tap: true });
      await choose();
      setPendingPackage(null);
      ctx.notices.toast(t`Installed ${pkg.name}.`);
      ctx.go('#/plugins');
      return;
    }
    await checkPackageId(ctx.plugins, pkg.id, p.from?.source);
    await ctx.plugins.install(p.files, p.from);
    await choose();
  } catch (e) {
    if (!explainStorageFull(ctx, e)) ctx.notices.card({ tone: 'warn', title: t`${pkg.name} wasn't installed`, body: message(e) });
    buttons.forEach((b) => { b.disabled = false; });
    return;
  }
  setPendingPackage(null);
  if ((await ctx.plugins.installed())[pkg.id]?.enabled === false) {
    // A new version of one that is off stays off, and its code doesn't run (fix pass 8a-5).
    ctx.notices.toast(t`Updated ${pkg.name}. It stays off.`);
  } else if (ctx.plugins.needsRestart(pkg.id)) {
    restartCard(ctx, pkg.name);
  } else {
    try {
      await ctx.plugins.start(pkg.id);
      ctx.notices.toast(t`Installed ${pkg.name}.`);
    } catch (e) {
      ctx.notices.card({ tone: 'warn', title: t`${pkg.name} was installed, but it didn't start`, body: sentences(message(e), t`You can turn it off or remove it in Settings → Plugins.`) });
    }
  }
  ctx.go('#/plugins');
}
