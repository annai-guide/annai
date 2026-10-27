import { h, crumb, linkIn, field, twoStep, jsonField, messageOf, showError, savedField, savedCheck, savedRadios, autosave, savingNote, whenGone, t, plural } from '../dom.js';
import { providerOf, providerBase, modelOf, saveProvider, setKey, diffLayer, SPEECH_ROLES } from '../../core/llm/config.js';
import { mergePatch } from '../../core/patch.js';
import { addListedModel, addModelById } from '../../core/llm/providers.js';
import { officialPlugins } from '../../core/llm/official.js';
import { testPanel } from '../model-check.js';
import { speechTestPanel } from '../speech-check.js';
import { sourceLine, sourceHost } from './plugin-install.js';
import { addressShown, localNote } from '../../core/llm/provider-desc.js';
import { platform } from '../platform.js';
import { pricesAt } from '../../core/llm/cost.js';
import { list, money, num, sentences } from '../format.js';
import { drawPanel, isProviderEntry, installMissing, sayFilled } from '../provider-setup.js';
import { OFFICIAL_NAMES } from '../../core/official-names.js';
import { setupOf } from '../../core/llm/setup.js';
import { keeperOf } from '../../core/llm/kept.js';
import { toolSwitches, setToolSwitch } from '../../core/agent/tools.js';

export { messageOf };

/**
 * A model's prices in a line: tokens, minutes of speech, or characters; those in force at `at`, and a change that is coming, with its date.
 * @param {import('../../core/llm/cost.js').Prices | null} prices @param {number} [at]
 */
export function priceLine(prices, at = Date.now()) {
  if (!prices) return null;
  const price = (/** @type {number | undefined} */ n) => (n === undefined ? '?' : money(n, 'USD', { minimumFractionDigits: 0, maximumFractionDigits: 6 }));
  /** @param {import('../../core/llm/cost.js').PriceFields} p @returns {[string, string]} the prices short, and whole */
  const say = (p) => {
    if (typeof p.perMinute === 'number') return [t`${price(p.perMinute)} a minute of speech`, t`${price(p.perMinute)} a minute of speech`];
    if (typeof p.perMillionChars === 'number') return [price(p.perMillionChars), t`${price(p.perMillionChars)} per million characters`];
    if (!p.input && !p.output) return [t`free`, t`free`];
    return [t`${price(p.input)} in, ${price(p.output)} out`, t`${price(p.input)} in, ${price(p.output)} out per million tokens`];
  };
  const [now, whole] = say(pricesAt(prices, at));
  const next = (Array.isArray(prices.schedule) ? prices.schedule : []).map((e) => e?.from).filter((d) => Date.parse(`${d}T00:00:00Z`) > at).sort()[0];
  const then = next ? say(pricesAt(prices, Date.parse(`${next}T00:00:00Z`)))[0] : now;
  return then !== now ? t`${whole} (from ${next}: ${then})` : whole;
}

/** The free-tier switch's words: who doesn't charge, as the description names it, else the plugin's name. @param {true | string} freeTier @param {string} pluginName */
export const freeTierLabel = (freeTier, pluginName) => t`This key is on the free tier (${typeof freeTier === 'string' ? freeTier : pluginName} doesn't charge)`;

/** What a provider keeps (G2), named before a removal, or a key change (key). @param {{ turns: number, waiting: number, days: number, who: string[] }} k @param {boolean} online @param {boolean} [key] */
export function keptWords({ turns, waiting, days, who }, online, key = false) {
  const n = turns + waiting;
  if (!n) return '';
  const name = who.length ? list(who) : t`The provider`;
  const upTo = num(days, { style: 'unit', unit: 'day', unitDisplay: 'long' });
  if (online && key) {
    return plural(n, "With a new key or address, or Remove key, annai first asks {0} to delete the # turn of your conversations it keeps; any it can't in 10 seconds, {0} keeps until it expires, up to {1}.",
      "With a new key or address, or Remove key, annai first asks {0} to delete the # turns of your conversations it keeps; any it can't in 10 seconds, {0} keeps until they expire, up to {1}.", name, upTo);
  }
  if (online) {
    return plural(n, "First, annai asks {0} to delete the # turn of your conversations it keeps; any it can't in 10 seconds, {0} keeps until it expires, up to {1}.",
      "First, annai asks {0} to delete the # turns of your conversations it keeps; any it can't in 10 seconds, {0} keeps until they expire, up to {1}.", name, upTo);
  }
  if (key) {
    return plural(n, 'Offline, a new key or address, or Remove key, leaves {0} the # turn it keeps until it expires, up to {1}.',
      'Offline, a new key or address, or Remove key, leaves {0} the # turns it keeps until they expire, up to {1}.', name, upTo);
  }
  return plural(n, '{0} keeps # turn until it expires, up to {1}.', '{0} keeps # turns until they expire, up to {1}.', name, upTo);
}

/** keptWords in el, counted now, as the warning shows. @param {any} ctx @param {HTMLElement} el @param {{ provider?: string, plugin?: string }} [o] @param {boolean} [key] */
export function warnKept(ctx, el, o = {}, key = false) {
  ctx.llm?.keptCount?.(o).then((/** @type {any} */ k) => { el.textContent = keptWords(k, navigator.onLine !== false, key); }, () => {});
}

/**
 * One provider (spec §9.2, §9.8): its name, one key, its address and extra headers (saved together,
 * §16.1), then each ability with its switch, its own address, tunables, fields and models, and Remove.
 * Drawn from the provider plugin's description, as data; a plugin with code adds its own panel (decision 15).
 * @param {any} ctx @param {string} id
 */
export async function renderProvider(ctx, id) {
  await ctx.llm.ready;
  const cfg = await ctx.llm.config();
  const rec = cfg.providers[id];
  if (!rec) return h('div', { class: 'screen' }, h('h1', { class: 'title', text: t`This provider no longer exists` }), h('p', {}, h('a', { href: '#/models' }, t`Back to Models`)));
  const types = ctx.llm.types();
  /** @param {string} type */
  const tunablesFor = (type) => types.get(type)?.tunables ?? {};
  const p = providerOf(rec, tunablesFor);
  const src = ctx.llm.providers().find((/** @type {any} */ s) => s.plugin === rec.plugin);
  const desc = src?.provider;
  const installed = (await ctx.plugins.installed())[rec.plugin];
  // What a plugin that isn't running is called comes from annai's catalog, never as its id (the second emulator re-check).
  const catalog = (!src && !installed) || Object.values(p.abilities).some((a) => !types.has(a.type)) ? await officialPlugins().catch(() => null) : null;
  const catalogName = (/** @type {string | undefined} */ id) => catalog?.find((/** @type {any} */ e) => e.id === id)?.name ?? null;
  /** A protocol by name: running, else annai's own from the catalog, else nothing to name. @param {string} type @returns {string | null} */
  const protocolName = (type) => types.get(type)?.name ?? catalogName(/** @type {Record<string, string>} */ (OFFICIAL_NAMES['endpoint-type'])[type]);
  const pluginName = src?.name ?? installed?.name ?? catalogName(rec.plugin);
  const hasKey = Boolean(await ctx.llm.keyFor(id));
  const status = h('p', { class: 'sub', role: 'status' });
  const title = h('h1', { class: 'title', text: p.name });
  const saveFields = saver(ctx, id, tunablesFor, null);
  const name = h('input', { id: 'provider-name', autocomplete: 'off', value: p.name });
  const url = h('input', { id: 'provider-url', autocomplete: 'off', autocapitalize: 'off', inputmode: 'url', value: p.baseUrl, placeholder: /* en */ 'https://…' });
  // A plugin with code may draw its own part in the key's place, such as a sign-in (decision 15).
  const panel = drawPanel(ctx, rec.plugin, { id, name: p.name, key: hasKey });
  const key = desc?.key === 'none' || (panel && setupOf(ctx.registry, rec.plugin)?.keyField === false) ? null : h('input', { id: 'provider-key', type: 'password', autocomplete: 'off', placeholder: hasKey ? t`saved (type a new one to replace it)` : t`not set` });
  const headers = jsonField(t`Extra headers (JSON)`, 'provider-headers', p.headers);
  // The address, key and extra headers (often a credential too) are saved together with a button, so a half-typed connection is never used.
  const saving = h('span', { class: 'sub', role: 'status' });
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: () => {
      const here = location.hash;
      savingNote(saving, async () => {
        try {
          // Checked as a description's is: a typed address without its scheme would send the key to annai's own site (fix pass).
          const wrong = url.value.trim() ? addressShown(url.value.trim()) : null;
          if (wrong) throw new Error(wrong);
          const typed = key?.value.trim() ?? '';
          const write = async () => {
            await saveFields({ baseUrl: url.value.trim(), headers: headers.read() });
            if (typed) await setKey(ctx.store, id, typed);
          };
          // A new key or address: what the provider keeps is deleted first, with the old one (G2).
          if (url.value.trim() !== p.baseUrl || (typed && typed !== await ctx.llm.keyFor(id))) await asking(status, () => ctx.llm.reconnect(id, write));
          else await write();
          return true;
        } catch (err) {
          showError(status, err);
          return false;
        }
      }, async (saved) => {
        if (!saved) return;
        if (location.hash === here) await ctx.render(); // not on a screen opened meanwhile
        ctx.notices.toast(t`Saved`);
      });
    },
  }, t`Save`);
  const others = Object.values(cfg.providers).filter((x) => x.plugin === rec.plugin && x.id !== id).length;
  // What goes with it, named before the tap: its plugin when it is the last, and the protocols nothing else needs.
  const going = await ctx.llm.removalOf(id);
  const state = await ctx.plugins.installed();
  const protocols = going.protocols.map((x) => String(state[x]?.name ?? x)).sort();
  const plugin = pluginName ?? p.name;
  const removes = [going.plugin && protocols.length ? t`Removes its key, its models and their places in roles, and the ${plugin} plugin, with ${list(protocols)}, which nothing else needs.`
    : going.plugin ? t`Removes its key, its models and their places in roles, and the ${plugin} plugin.`
      : protocols.length ? t`Removes its key, its models and their places in roles, with ${list(protocols)}, which nothing else needs.`
        : t`Removes its key, its models and their places in roles.`];
  const host = installed ? sourceHost(installed) : null;
  if (!others && host) removes.push(t`To add it back, you'll need its address again: ${host}.`);
  if (!others && installed?.source === 'file') removes.push(installed.file ? t`To add it back, you'll need its file again (${installed.file}).` : t`To add it back, you'll need its file again.`);
  const view = { ctx, id, tunablesFor, desc, protocolName };
  const removing = h('p', { class: 'sub', role: 'status' });
  // What a provider keeps, named as its warning shows: typing a new key or address, or arming a removal (G2).
  const keyWarn = h('p', { class: 'sub' });
  const removeWarn = h('p', { class: 'sub' });
  const warnKey = () => warnKept(ctx, keyWarn, { provider: id }, true);
  for (const input of [url, key]) input?.addEventListener('input', warnKey);
  /** work, saying meanwhile that the provider is asked to delete what it keeps. @template T @param {HTMLElement} el @param {() => Promise<T>} work @returns {Promise<T>} */
  const asking = async (el, work) => {
    const k = await ctx.llm.keptCount({ provider: id });
    if (k.turns + k.waiting) el.textContent = t`Asking ${list(k.who)} to delete what it keeps…`;
    try {
      return await work();
    } finally {
      el.textContent = '';
    }
  };
  // A server you run: what reaching it takes; on a phone, a warning while its address is localhost, which can't work there (the user, 2026-10-22).
  const serverNote = { el: desc?.local || desc?.serverNote ? h('p', { class: 'sub', 'data-note': 'local-server', text: localNote(desc.baseUrl) }) : null };
  const paintNote = () => serverNote.el?.classList.toggle('warn', platform() !== 'desktop' && /^http:\/\/(localhost|127\.0\.0\.1)(?![\w.-])/i.test(url.value.trim()));
  url.addEventListener('input', paintNote);
  paintNote();
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/models', t`Models`)),
    title,
    h('p', { class: 'sub', text: [pluginName && pluginName !== p.name ? pluginName : null, installed?.source === 'official' ? null : installed ? sourceLine(installed) : null].filter(Boolean).join(' · ') }),
    src ? null : await missingPlugin(ctx, rec.plugin, installed, catalog),
    h('section', { class: 'panel', 'aria-label': t`Provider` },
      savedField(t`Name`, name, () => name.value.trim() || providerBase(rec).name, async (v) => { title.textContent = (await saveFields({ name: v })).name; }),
      h('h3', { text: t`Connection` }),
      field(t`Address`, url),
      panel,
      key ? field(t`API key`, key) : null,
      desc?.note || desc?.keyUrl
        ? h('p', { class: 'sub' }, desc.note ?? '', desc.note && desc.keyUrl ? ' ' : '', desc.keyUrl ? h('a', { href: desc.keyUrl, target: '_blank', rel: 'noopener' }, t`Get a key`) : null)
        : null,
      serverNote.el,
      desc?.freeTier ? savedCheck(freeTierLabel(desc.freeTier, pluginName ?? p.name), p.free, async (on) => {
        await ctx.llm.setFree(id, on);
        for (const s of document.querySelectorAll('section.panel')) s.dispatchEvent(new Event('redraw')); // its tools' switches follow (G4)
      }).el : null,
      desc?.freeTier ? h('p', { class: 'sub', text: t`On, its calls show as free in the Trace, and count nothing toward Spend per day.` }) : null,
      headers.el,
      h('div', { class: 'acts' }, save, saving,
        hasKey ? twoStep(t`Remove key`, t`Tap again to remove the key`, async () => {
          await asking(status, () => ctx.llm.reconnect(id, () => setKey(ctx.store, id, null)));
          await ctx.llm.unbench(id);
          ctx.notices.toast(t`Key removed`);
          ctx.render();
        }, warnKey) : null),
      keyWarn,
      status),
    desc?.roles ? suggestionsPanel(ctx, id, /** @type {any} */ (src)) : null,
    ...await Promise.all(Object.values(p.abilities).map((a) => abilityPanel(view, a.id, (rec.template?.added ?? []).includes(a.id)))),
    h('div', { class: 'panel' },
      h('p', { class: 'sub', text: sentences(...removes) }),
      h('div', { class: 'acts' }, twoStep(t`Remove provider`, t`Tap again to remove it`, async () => {
        try {
          await asking(removing, () => ctx.llm.removeProvider(id));
          ctx.go('#/models');
        } catch (e) {
          showError(status, e);
        }
      }, () => warnKept(ctx, removeWarn, { provider: id }))),
      removeWarn, // under the button, so arming it doesn't move it
      removing));
}

/**
 * A provider plugin's own Add flow (decision 15), such as Custom provider's look: its panel, whose provider opens
 * its page, and Add by hand. Nothing is installed here: Add did. @param {any} ctx @param {string} pluginId
 */
export async function renderNewProvider(ctx, pluginId) {
  await ctx.llm.ready;
  const src = ctx.llm.providers().find((/** @type {any} */ s) => s.plugin === pluginId);
  const open = (/** @type {string} */ id) => ctx.go(`#/models/provider?id=${encodeURIComponent(id)}`);
  const panel = src && drawPanel(ctx, pluginId, null, { added: open });
  const status = h('p', { class: 'sub', role: 'status', text: panel ? '' : src ? t`${src.name} has no way of its own to add it here: add it by hand, and set it up on its page.` : t`This provider's plugin isn't running. Add it from Add, or look at it in Settings → Plugins.` });
  const byHand = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      byHand.disabled = true;
      try {
        /** @type {string[]} */
        const filled = [];
        /** @type {Record<string, string>} */
        const costs = {};
        const added = await ctx.llm.addProvider(pluginId, { official: (await ctx.plugins.installed())[pluginId]?.source === 'official', filled, costs });
        open(added);
        sayFilled(ctx, pluginId, filled, costs);
      } catch (e) {
        showError(status, e);
        byHand.disabled = false;
      }
    },
  }, t`Add by hand`);
  const screen = h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb('#/add?kind=providers&from=models', t`Add`)),
    h('h1', { class: 'title', text: src?.name ?? t`Add a provider` }),
    panel ? h('section', { class: 'panel', 'aria-label': src.name }, panel) : null,
    h('section', { class: 'panel', 'aria-label': t`By hand` },
      panel ? h('p', { class: 'sub', text: t`Or add ${src.name} as it is, and set up its key and what it offers on its own page.` }) : null,
      src ? h('div', { class: 'acts' }, byHand) : null,
      status));
  // Left for another screen, not drawn again: what Add's tap brought goes if unused.
  whenGone(screen, () => {
    if (new URLSearchParams(location.hash.split('?')[1] ?? '').get('new') !== pluginId) ctx.llm.leaveAdd(pluginId).catch((/** @type {unknown} */ e) => console.warn(/* en */ "a provider plugin with no provider couldn't be removed", e));
  });
  return screen;
}

/**
 * What a provider's page says when its plugin isn't running, in words with no plugin id (fixes-ui 16): installed, a link to it;
 * annai's own and missing (a restore brings providers back without theirs), Install it, here; another's, that annai can't fetch it.
 * @param {any} ctx @param {string} plugin @param {any} installed its install state, if any @param {any[] | null} catalog annai's catalog, when it could be loaded
 */
async function missingPlugin(ctx, plugin, installed, catalog) {
  if (installed) {
    // The link is a value of the message, so every translation has it.
    const look = t`Look at it in Settings → Plugins`;
    return h('p', { class: 'risk-note' }, ...linkIn(t`Its plugin, ${installed.name}, isn't running, so annai can't say what it offers. ${look}.`, h('a', { href: `#/plugins/${encodeURIComponent(plugin)}` }, look)));
  }
  const entry = catalog?.find((/** @type {any} */ p) => p.id === plugin && isProviderEntry(p));
  if (!entry) {
    return h('p', { class: 'risk-note', text: catalog ? t`The plugin it was made from isn't on this device, and it isn't one of annai's own providers, so annai can't fetch it. Install it again from where you got it, in Settings → Plugins → Add, or remove this provider.`
      : t`Its plugin isn't on this device, and annai's catalog couldn't be loaded to fetch it. Connect to the internet and open this page again.` });
  }
  const status = h('p', { class: 'sub', role: 'status' });
  const install = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      install.disabled = true;
      status.textContent = t`Installing…`;
      try {
        await installMissing(ctx, entry);
        ctx.render();
      } catch (e) {
        showError(status, e);
        install.disabled = false;
      }
    },
  }, t`Install it`);
  return h('div', { class: 'risk-note' }, h('p', { text: t`Its plugin, ${entry.name}, isn't installed, so annai can't say what it offers.` }), h('div', { class: 'acts' }, install), status);
}

/** @typedef {{ ctx: any, id: string, tunablesFor: (type: string) => Record<string, any>, desc: any, protocolName: (type: string) => string | null }} View */

/**
 * Saves fields into the user's layer of the provider, or of one ability, as it is now (a function works
 * a value out from it), and puts its models back in use: what failed may be fixed. Gives what it saved.
 * @param {any} ctx @param {string} id @param {(type: string) => Record<string, any>} tunablesFor @param {string | null} abilityId
 * @returns {(fields: Record<string, any>) => Promise<any>}
 */
const saver = (ctx, id, tunablesFor, abilityId) => async (fields) => {
  const now = (await ctx.llm.config()).providers[id];
  if (!now) throw new Error(t`This provider no longer exists.`);
  const pick = (/** @type {any} */ p) => (abilityId ? p.abilities[abilityId] : p);
  const values = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'function' ? v(pick(providerOf(now, tunablesFor))) : v]));
  const mine = { ...(abilityId ? now.user?.abilities?.[abilityId] : now.user) };
  for (const k of Object.keys(values)) delete mine[k];
  const layer = { ...mine, ...diffLayer(values, pick(providerBase(now, tunablesFor))) };
  const next = { ...now, user: abilityId ? { ...now.user, abilities: { ...now.user?.abilities, [abilityId]: layer } } : layer };
  await saveProvider(ctx.ws, next);
  await ctx.llm.unbench(id);
  return pick(providerOf(next, tunablesFor));
};

/**
 * One ability: its name and protocol, and its switch, saved as it changes. Switched on, the rest
 * follows: the protocol's Install where it isn't running, its own address, tunables and fields,
 * photo uploads, its models, and Test. A switch drawing the rest again keeps its own place.
 * @param {View} view @param {string} abilityId @param {boolean} added new in the last update, switched off
 */
async function abilityPanel(view, abilityId, added) {
  const { ctx, id, tunablesFor } = view;
  const rec = (await ctx.llm.config()).providers[id];
  const a = providerOf(rec, tunablesFor).abilities[abilityId];
  const body = h('div', {});
  // replaceChildren, unlike h, would show a null as the word.
  const draw = async () => body.replaceChildren(...(await abilityBody(view, abilityId)).filter((n) => n !== null));
  const use = savedCheck(t`Use ${a.name}`, a.on, async (on) => {
    await ctx.llm.setAbility(id, abilityId, on);
    await draw();
  });
  await draw();
  return h('section', { class: 'panel', 'aria-label': a.name, onredraw: draw },
    h('h2', { class: 'section', text: a.name }),
    h('p', { class: 'sub', text: [view.protocolName(a.type), added && !a.on ? t`New in the last update` : null].filter(Boolean).join(' · ') }),
    use.el,
    body);
}

/**
 * What an ability shows below its switch, as it is now. @param {View} view @param {string} abilityId @returns {Promise<(HTMLElement | null)[]>}
 */
async function abilityBody(view, abilityId) {
  const { ctx, id, tunablesFor, desc } = view;
  const cfg = await ctx.llm.config();
  const rec = cfg.providers[id];
  const a = providerOf(rec, tunablesFor).abilities[abilityId];
  const note = desc?.abilities?.[abilityId]?.note ? h('p', { class: 'sub', text: desc.abilities[abilityId].note }) : null;
  if (!a?.on) return [note];
  const type = ctx.llm.types().get(a.type);
  if (!type) return [installPanel(ctx, a.type, view.protocolName(a.type), () => ctx.render()), note];
  const saveAbility = saver(ctx, id, tunablesFor, abilityId);
  // Its own address, not the provider's it falls back to.
  const own = String(mergePatch(rec.template?.values?.abilities?.[abilityId] ?? {}, rec.user?.abilities?.[abilityId] ?? {}).baseUrl ?? '');
  const address = h('input', { id: `ability-${abilityId}-url`, autocomplete: 'off', autocapitalize: 'off', inputmode: 'url', value: own, placeholder: providerOf(rec).baseUrl ? t`the provider's: ${providerOf(rec).baseUrl}` : t`the provider's: none yet` });
  // A new address lets go of what the provider keeps at the old one, so it warns as the provider's own address does (verification).
  const addressWarn = h('p', { class: 'sub' });
  if (type.keeps) address.addEventListener('input', () => warnKept(ctx, addressWarn, { provider: id }, true));
  const tunables = jsonField(t`Tunables (JSON)`, /* en */ `ability-${abilityId}-tunables`, a.tunables);
  const extra = jsonField(t`Extra request fields (JSON)`, /* en */ `ability-${abilityId}-extra`, a.extraBody);
  // Where the protocol stores files, photos go there once, then by id (spec §4.8). The switch is a tunable.
  const uploads = type.uploadRequest ? savedCheck(t`Upload photos to this provider (each expires after 48 hours)`, a.tunables?.uploads !== false,
    async (on) => tunables.show((await saveAbility({ tunables: (/** @type {any} */ was) => ({ ...was.tunables, uploads: on }) })).tunables)) : null;
  // Where the protocol can, the provider keeps the conversation between turns (G2): a tunable too. Off, what it keeps is deleted.
  const { name: who, holds, server, note: keepNote } = keeperOf(type.keeps, rec.plugin, providerOf(rec).name);
  const keyless = !(await ctx.llm.keyFor(id));
  const keep = type.keeps ? savedCheck(t`Let ${who} keep the conversation between turns: sends less each time.`, a.tunables?.keep !== false, async (on) => {
    tunables.show((await saveAbility({ tunables: (/** @type {any} */ was) => ({ ...was.tunables, keep: on }) })).tunables);
    if (!on) await ctx.llm.forgetEndpoint(`${id}/${abilityId}`);
  }) : null;
  const waiting = keep ? (await ctx.llm.keptCount({ endpoint: `${id}/${abilityId}` })).waiting : 0;
  // Tunables the protocol offers in words (G3): one of its options, or a switch, showing what the JSON field saves too.
  const tune = (/** @type {string} */ k) => async (/** @type {any} */ v) => tunables.show((await saveAbility({ tunables: (/** @type {any} */ was) => ({ ...was.tunables, [k]: v }) })).tunables);
  const choices = Object.entries(type.choices ?? {}).map(([k, c]) => ({ k, el: c.options ? savedRadios(c.label, Object.entries(c.options), String(a.tunables?.[k]), tune(k))
    : savedCheck(c.label, a.tunables?.[k] !== false, tune(k)).el }));
  const showChoices = (/** @type {Record<string, any>} */ t) => {
    for (const { k, el } of choices) for (const input of el.querySelectorAll('input')) input.checked = input.type === 'radio' ? input.value === String(t[k]) : t[k] !== false;
  };
  const models = Object.values(cfg.models).filter((m) => m.provider === id && m.ability === abilityId).map(modelOf);
  const tools = await providerToolSwitches(ctx, models, providerOf(rec).free, typeof desc?.freeTier === 'string' ? desc.freeTier : providerOf(rec).name);
  // What to do with a model from before the provider's list gave windows, while there is one.
  const old = desc?.abilities?.[abilityId]?.noWindowNote && models.some((m) => !m.contextWindow) ? h('p', { class: 'sub', text: desc.abilities[abilityId].noWindowNote }) : null;
  const speech = a.kind === 'transcription' ? 'in' : a.kind === 'voice' ? 'out' : null;
  const first = models[0];
  return [
    h('div', { class: 'saving' }, field(t`Its own address`, address), ...autosave(address, () => {
      const v = address.value.trim();
      const wrong = v ? addressShown(v) : null;
      if (wrong) throw new Error(wrong);
      return v;
    }, (v) => (keep ? ctx.llm.reconnect(id, () => saveAbility({ baseUrl: v })) : saveAbility({ baseUrl: v })))), // a new address: what it keeps there goes first
    h('p', { class: 'sub', text: t`Empty: the provider's address. Each setting here is saved as you change it.` }),
    addressWarn,
    uploads?.el ?? null,
    keep?.el ?? null,
    keep ? h('p', { class: 'sub', text: sentences(server ? t`${who} keeps your conversations with Shiori, with their photos, voice messages and where you are as she knows it: as long as that server keeps them.`
      : holds ? t`${who} keeps your conversations with Shiori, with their photos, voice messages and where you are as she knows it: ${holds}.`
      : plural(type.keeps.days, '{0} keeps your conversations with Shiori, with their photos, voice messages and where you are as she knows it: a day on a free key, up to # day on a paid one.',
        '{0} keeps your conversations with Shiori, with their photos, voice messages and where you are as she knows it: a day on a free key, up to # days on a paid one.', who),
    t`annai deletes them when you remove their trip, this provider or everything (Erase), change or remove its key, or turn this off.`, t`Off, each turn sends the whole conversation.`,
    keepNote, keyless ? t`It needs this provider's key: without one, each turn sends the whole conversation.` : '') }) : null,
    waiting ? h('p', { class: 'sub', text: keyless ? plural(waiting, "# deletion waiting: annai can't send it without this provider's key.", "# deletions waiting: annai can't send them without this provider's key.")
      : plural(waiting, '# deletion waiting: annai sends it when it can reach {0}.', '# deletions waiting: annai sends them when it can reach {0}.', who) }) : null,
    ...choices.map((c) => c.el),
    ...tools,
    h('div', { class: 'saving' }, tunables.el, ...autosave(tunables.area, tunables.read, async (t) => {
      const saved = (await saveAbility({ tunables: { ...t, ...(uploads ? { uploads: uploads.input.checked } : {}), ...(keep ? { keep: keep.input.checked } : {}) } })).tunables;
      tunables.show(saved);
      showChoices(saved);
    })),
    h('div', { class: 'saving' }, extra.el, ...autosave(extra.area, extra.read, async (x) => extra.show((await saveAbility({ extraBody: x })).extraBody))),
    modelsPart(ctx, id, abilityId, models),
    old,
    first && speech ? speechTestPanel(ctx, first, speech, cfg.models[first.id].verified, t`Test ${first.name}`) : null,
    first && !speech ? testPanel(ctx, first.id, cfg.models[first.id].verified, t`Test ${first.name}`, a.kind === 'realtime') : null,
    note,
  ];
}

/**
 * Switches for the provider's own tools its models offer with words for this page (G4: "Let Gemini search Google"), the same
 * as Settings → Tools'. One that is paid only is off while the key is on the free tier, saying why. @param {any} ctx
 * @param {import('../../core/llm/config.js').Model[]} models @param {boolean} free @param {string} who doesn't charge on it
 */
async function providerToolSwitches(ctx, models, free, who) {
  const switches = await toolSwitches(ctx.ws);
  return [...new Map(models.flatMap((m) => m.providerTools ?? []).filter((x) => x.label).map((x) => [x.id, x])).values()].flatMap((tool) => {
    const out = Boolean(tool.paidOnly && free);
    const sw = savedCheck(String(tool.label), !out && switches[`provider:${tool.id}`] !== false, (/** @type {boolean} */ v) => setToolSwitch(ctx.ws, `provider:${tool.id}`, v));
    sw.input.disabled = out;
    return [sw.el, h('p', { class: 'sub', text: !out ? tool.note ?? '' : tool.kind === 'search' ? t`${who} doesn't offer search on the free tier.`
      : tool.kind === 'fetch' ? t`${who} doesn't offer fetch on the free tier.` : t`${who} doesn't offer ${tool.name} on the free tier.` })];
  });
}

/** "Install it" for a protocol that isn't running (a setup action, decision 9). @param {any} ctx @param {string} typeId @param {string | null} name its plugin's name, when annai knows it @param {() => unknown} done */
function installPanel(ctx, typeId, name, done) {
  const status = h('p', { class: 'sub', role: 'status', text: name ? t`This needs the ${name} plugin, which isn't running.` : t`This needs a plugin that isn't running.` });
  const btn = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      btn.disabled = true;
      status.textContent = t`Installing…`;
      try {
        await ctx.llm.ensureType(typeId);
        done();
      } catch (e) {
        showError(status, e);
        btn.disabled = false;
      }
    },
  }, t`Install it`);
  return h('div', {}, status, h('div', { class: 'acts' }, btn));
}

/** An ability's models, Add a model by id and Fetch model list. @param {any} ctx @param {string} id @param {string} abilityId @param {import('../../core/llm/config.js').Model[]} models */
function modelsPart(ctx, id, abilityId, models) {
  const status = h('p', { class: 'sub', role: 'status' });
  const listSlot = h('div', {});
  const providerId = h('input', { id: `model-id-${abilityId}`, autocomplete: 'off', autocapitalize: 'off', placeholder: t`the provider's model id` });
  const add = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const value = providerId.value.trim();
      if (!value) return;
      try {
        await addModelById(ctx, id, abilityId, value);
        ctx.render();
      } catch (e) {
        showError(status, e);
      }
    },
  }, t`Add model`);
  const fetchList = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      fetchList.disabled = true;
      status.textContent = t`Asking for its models…`;
      try {
        const listed = await ctx.llm.listModels(id, abilityId);
        status.textContent = plural(listed.length, '# model.', '# models.');
        listSlot.replaceChildren(listedModels(ctx, id, abilityId, listed, models, await ctx.llm.config()));
      } catch (e) {
        showError(status, e);
      } finally {
        fetchList.disabled = false;
      }
    },
  }, t`Fetch model list`);
  const rows = models.map((m) => h('li', {}, h('a', { class: 'card', href: `#/models/model?id=${encodeURIComponent(m.id)}` },
    h('span', { class: 'name', text: m.name }),
    h('span', { class: 'sub', text: [m.providerId !== m.name ? m.providerId : null, m.contextWindow ? t`${num(Math.round(m.contextWindow / 1000), { useGrouping: false })}K context` : null, priceLine(m.prices)].filter(Boolean).join(' · ') }))));
  return h('div', {},
    h('h3', { text: t`Its models` }),
    rows.length ? h('ul', { class: 'cards' }, ...rows) : h('p', { class: 'empty', text: t`No models yet.` }),
    h('div', { class: 'row' }, field(t`Add a model by id`, providerId), h('div', { class: 'acts' }, add, fetchList)),
    status,
    listSlot);
}

/**
 * The models an ability listed, minus those already added, with a filter. One whose name another model has says where
 * that is, as adding it by id refuses it, rather than adding it again as "name (2)" (the emulator pass).
 * @param {any} ctx @param {string} id @param {string} abilityId @param {import('../../core/llm/contract.js').ListedModel[]} listed @param {import('../../core/llm/config.js').Model[]} have
 * @param {import('../../core/llm/config.js').ModelConfig} cfg
 */
function listedModels(ctx, id, abilityId, listed, have, cfg) {
  const owned = new Set(have.map((m) => m.providerId));
  const taken = new Map(Object.values(cfg.models).map(modelOf).map((m) => [m.name.toLowerCase(), cfg.providers[m.provider] ? providerOf(cfg.providers[m.provider]).name : '']));
  const filter = h('input', { id: `model-filter-${abilityId}`, autocomplete: 'off', placeholder: t`for example: haiku` });
  const list = h('ul', { class: 'listed' });
  const show = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = listed.filter((m) => !owned.has(m.providerId) && (!q || `${m.providerId} ${m.name ?? ''}`.toLowerCase().includes(q))).slice(0, 50);
    list.replaceChildren(...rows.map((m) => {
      const on = taken.get((m.name || m.providerId).toLowerCase());
      const { loaded, ...model } = m; // said here, never kept on the model
      const named = m.name && m.name !== m.providerId ? `${m.name} (${m.providerId})` : m.providerId;
      return h('li', { class: 'acts' },
        h('span', { text: loaded ? t`${named} · loaded` : named }),
        on !== undefined ? h('span', { class: 'sub', text: on ? t`Already added, on ${on}` : t`Already added, on another provider` }) : h('button', {
          class: 'btn', type: 'button', 'aria-label': t`Add ${m.providerId}`,
          onclick: async () => {
            await addListedModel(ctx, id, abilityId, model);
            ctx.render();
          },
        }, t`Add`));
    }));
  };
  filter.addEventListener('input', show);
  show();
  return h('div', {}, field(t`Filter the list`, filter), list);
}

/** Buttons that put a provider's suggested models in the roles ("free", "recommended"). @param {any} ctx @param {string} id @param {import('../../core/llm/providers.js').ProviderSource} src */
function suggestionsPanel(ctx, id, src) {
  const roles = src.provider.roles ?? {};
  const speech = Object.values(roles).some((r) => SPEECH_ROLES.some((role) => role in r));
  /** @type {Record<string, string>} */
  const labels = { free: t`Use the free models`, recommended: t`Use the recommended models` };
  return h('section', { class: 'panel', 'aria-label': t`Suggested models` },
    h('p', { class: 'sub', text: speech ? t`${src.name} suggests a model for each role. Its speech models then go ahead of the phone's own dictation and the browser voice, which are free, so any that cost money are tried before them.`
      : t`${src.name} suggests a model for each role.` }),
    h('div', { class: 'acts' }, ...Object.keys(roles).map((which) => h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          // What it switched on, or couldn't, said after the roles.
          const r = await ctx.llm.useSuggestion(id, which);
          ctx.notices.toast(sentences(t`Roles updated.`, ...r.on.map((/** @type {string} */ n) => t`${n} switched on.`),
            ...r.failed.map((/** @type {any} */ f) => t`${f.name} couldn't be switched on: ${messageOf(f.error)}`)));
        } catch (e) {
          ctx.notices.toast(messageOf(e));
        }
        ctx.render();
      },
    }, labels[which] ?? t`Use the ${which} models`))));
}
