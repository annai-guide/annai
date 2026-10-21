import { h, field, twoStep, jsonField, messageOf, savedField, savedCheck, savedRadios, autosave, queueSave, whenGone } from '../dom.js';
import { providerOf, providerBase, modelOf, saveProvider, setKey, diffLayer, SPEECH_ROLES } from '../../core/llm/config.js';
import { mergePatch } from '../../core/patch.js';
import { addListedModel, addModelById } from '../../core/llm/providers.js';
import { officialPlugins } from '../../core/llm/official.js';
import { testPanel } from '../model-check.js';
import { speechTestPanel } from '../speech-check.js';
import { sourceLine } from './plugin-install.js';
import { addressProblem } from '../../core/llm/provider-desc.js';
import { andList } from '../format.js';
import { drawPanel } from '../provider-setup.js';
import { setupOf } from '../../core/llm/setup.js';
import { toolSwitches, setToolSwitch } from '../../core/agent/tools.js';

export { messageOf };

/** A model's prices in a line: tokens, minutes of speech, or characters. @param {import('../../core/llm/cost.js').Prices | null} prices */
export function priceLine(prices) {
  if (!prices) return null;
  if (typeof prices.perMinute === 'number') return `$${prices.perMinute} a minute of speech`;
  if (typeof prices.perMillionChars === 'number') return `$${prices.perMillionChars} per million characters`;
  if (!prices.input && !prices.output) return 'free';
  return `$${prices.input ?? '?'} in, $${prices.output ?? '?'} out per million tokens`;
}

/** The free-tier switch's words: who doesn't charge, as the description names it, else the plugin's name. @param {true | string} freeTier @param {string} pluginName */
export const freeTierLabel = (freeTier, pluginName) => `This key is on the free tier (${typeof freeTier === 'string' ? freeTier : pluginName} doesn't charge)`;

/** What a provider keeps (G2), named before a removal, or a key change (key). @param {{ turns: number, waiting: number, days: number, who: string[] }} k @param {boolean} online @param {boolean} [key] */
export function keptWords({ turns, waiting, days, who }, online, key = false) {
  const n = turns + waiting;
  if (!n) return '';
  const name = who.join(' and ') || 'The provider';
  const what = `${n} turn${n === 1 ? '' : 's'}`;
  const until = `until ${n === 1 ? 'it expires' : 'they expire'}, up to ${days} day${days === 1 ? '' : 's'}`;
  const how = key ? 'With a new key or address, or Remove key, annai first' : 'First, annai';
  if (online) return `${how} asks ${name} to delete the ${what} of your conversations it keeps; any it can't in 10 seconds, ${name} keeps ${until}.`;
  return key ? `Offline, a new key or address, or Remove key, leaves ${name} the ${what} it keeps ${until}.` : `${name} keeps ${what} ${until}.`;
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
  if (!rec) return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'This provider no longer exists' }), h('p', {}, h('a', { href: '#/models' }, 'Back to Models')));
  const types = ctx.llm.types();
  /** @param {string} type */
  const tunablesFor = (type) => types.get(type)?.tunables ?? {};
  const p = providerOf(rec, tunablesFor);
  const src = ctx.llm.providers().find((/** @type {any} */ s) => s.plugin === rec.plugin);
  const desc = src?.provider;
  const installed = (await ctx.plugins.installed())[rec.plugin];
  const pluginName = src?.name ?? installed?.name ?? rec.plugin;
  const hasKey = Boolean(await ctx.llm.keyFor(id));
  const status = h('p', { class: 'sub', role: 'status' });
  const title = h('h1', { class: 'title', text: p.name });
  const saveFields = saver(ctx, id, tunablesFor, null);
  const name = h('input', { id: 'provider-name', autocomplete: 'off', value: p.name });
  const url = h('input', { id: 'provider-url', autocomplete: 'off', autocapitalize: 'off', inputmode: 'url', value: p.baseUrl, placeholder: 'https://…' });
  // A plugin with code may draw its own part in the key's place, such as a sign-in (decision 15).
  const panel = drawPanel(ctx, rec.plugin, { id, name: p.name, key: hasKey });
  const key = desc?.key === 'none' || (panel && setupOf(ctx.registry, rec.plugin)?.keyField === false) ? null : h('input', { id: 'provider-key', type: 'password', autocomplete: 'off', placeholder: hasKey ? 'saved (type a new one to replace it)' : 'not set' });
  const headers = jsonField('Extra headers (JSON)', 'provider-headers', p.headers);
  // The address, key and extra headers (often a credential too) are saved together with a button, so a half-typed connection is never used.
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: () => {
      const here = location.hash;
      queueSave(async () => {
        try {
          // Checked as a description's is: a typed address without its scheme would send the key to annai's own site (fix pass).
          const wrong = url.value.trim() ? addressProblem(url.value.trim()) : null;
          if (wrong) throw new Error(wrong);
          const typed = key?.value.trim() ?? '';
          const write = async () => {
            await saveFields({ baseUrl: url.value.trim(), headers: headers.read() });
            if (typed) await setKey(ctx.store, id, typed);
          };
          // A new key or address: what the provider keeps is deleted first, with the old one (G2).
          if (url.value.trim() !== p.baseUrl || (typed && typed !== await ctx.llm.keyFor(id))) await asking(status, () => ctx.llm.reconnect(id, write));
          else await write();
          ctx.notices.toast('Saved');
          if (location.hash === here) ctx.render(); // not on a screen opened meanwhile
        } catch (err) {
          status.textContent = messageOf(err);
        }
      });
    },
  }, 'Save');
  const others = Object.values(cfg.providers).filter((x) => x.plugin === rec.plugin && x.id !== id).length;
  // What goes with it, named before the tap: its plugin when it is the last, and the protocols nothing else needs.
  const going = await ctx.llm.removalOf(id);
  const state = await ctx.plugins.installed();
  const protocols = going.protocols.map((x) => String(state[x]?.name ?? x)).sort();
  const removes = [`Removes its key, its models and their places in roles${going.plugin ? `, and the ${pluginName} plugin` : ''}${protocols.length ? `, with ${andList(protocols)}, which nothing else needs` : ''}.`];
  if (!others && installed?.source === 'url') removes.push(`To add it back, you'll need its address again: ${sourceLine(installed).replace(/^From /, '')}.`);
  if (!others && installed?.source === 'file') removes.push(`To add it back, you'll need its file again${installed.file ? ` (${installed.file})` : ''}.`);
  const view = { ctx, id, tunablesFor, desc };
  const removing = h('p', { class: 'sub', role: 'status' });
  // What a provider keeps, named as its warning shows: typing a new key or address, or arming a removal (G2).
  const keyWarn = h('p', { class: 'sub' });
  const removeWarn = h('p', { class: 'sub' });
  const warnKey = () => warnKept(ctx, keyWarn, { provider: id }, true);
  for (const input of [url, key]) input?.addEventListener('input', warnKey);
  /** work, saying meanwhile that the provider is asked to delete what it keeps. @template T @param {HTMLElement} el @param {() => Promise<T>} work @returns {Promise<T>} */
  const asking = async (el, work) => {
    const k = await ctx.llm.keptCount({ provider: id });
    if (k.turns + k.waiting) el.textContent = `Asking ${k.who.join(' and ')} to delete what it keeps…`;
    try {
      return await work();
    } finally {
      el.textContent = '';
    }
  };
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/models' }, '← Models')),
    title,
    h('p', { class: 'sub', text: [pluginName !== p.name ? pluginName : null, installed?.source === 'official' ? null : installed ? sourceLine(installed) : null].filter(Boolean).join(' · ') }),
    src ? null : await missingPlugin(ctx, rec.plugin, installed),
    h('section', { class: 'panel', 'aria-label': 'Provider' },
      savedField('Name', name, () => name.value.trim() || providerBase(rec).name, async (v) => { title.textContent = (await saveFields({ name: v })).name; }),
      h('h3', { text: 'Connection' }),
      field('Address', url),
      panel,
      key ? field('API key', key) : null,
      desc?.note || desc?.keyUrl
        ? h('p', { class: 'sub' }, desc.note ?? '', desc.note && desc.keyUrl ? ' ' : '', desc.keyUrl ? h('a', { href: desc.keyUrl, target: '_blank', rel: 'noopener' }, 'Get a key') : null)
        : null,
      desc?.freeTier ? savedCheck(freeTierLabel(desc.freeTier, pluginName), p.free, async (on) => {
        await ctx.llm.setFree(id, on);
        for (const s of document.querySelectorAll('section.panel')) s.dispatchEvent(new Event('redraw')); // its tools' switches follow (G4)
      }).el : null,
      desc?.freeTier ? h('p', { class: 'sub', text: 'On, its calls show as free in the Trace, and count nothing toward Spend per day.' }) : null,
      headers.el,
      h('div', { class: 'acts' }, save,
        hasKey ? twoStep('Remove key', 'Tap again to remove the key', async () => {
          await asking(status, () => ctx.llm.reconnect(id, () => setKey(ctx.store, id, null)));
          await ctx.llm.unbench(id);
          ctx.notices.toast('Key removed');
          ctx.render();
        }, warnKey) : null),
      keyWarn,
      status),
    desc?.roles ? suggestionsPanel(ctx, id, /** @type {any} */ (src)) : null,
    ...await Promise.all(Object.values(p.abilities).map((a) => abilityPanel(view, a.id, (rec.template?.added ?? []).includes(a.id)))),
    h('div', { class: 'panel' },
      h('p', { class: 'sub', text: removes.join(' ') }),
      h('div', { class: 'acts' }, twoStep('Remove provider', 'Tap again to remove it', async () => {
        try {
          await asking(removing, () => ctx.llm.removeProvider(id));
          ctx.go('#/models');
        } catch (e) {
          status.textContent = messageOf(e);
        }
      }, () => warnKept(ctx, removeWarn, { provider: id }))),
      removeWarn, // under the button, so arming it doesn't move it
      removing));
}

/**
 * A provider plugin's own Add flow (decision 15), such as Another address's look: its panel, whose provider opens
 * its page, and Add by hand. Nothing is installed here: Add did. @param {any} ctx @param {string} pluginId
 */
export async function renderNewProvider(ctx, pluginId) {
  await ctx.llm.ready;
  const src = ctx.llm.providers().find((/** @type {any} */ s) => s.plugin === pluginId);
  const open = (/** @type {string} */ id) => ctx.go(`#/models/provider?id=${encodeURIComponent(id)}`);
  const panel = src && drawPanel(ctx, pluginId, null, { added: open });
  const status = h('p', { class: 'sub', role: 'status', text: panel ? '' : src ? `${src.name} has no way of its own to add it here: add it by hand, and set it up on its page.` : "This provider's plugin isn't running. Add it from Add, or look at it in Settings → Plugins." });
  const byHand = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      byHand.disabled = true;
      try {
        open(await ctx.llm.addProvider(pluginId, { roles: 'recommended', official: (await ctx.plugins.installed())[pluginId]?.source === 'official' }));
      } catch (e) {
        status.textContent = messageOf(e);
        byHand.disabled = false;
      }
    },
  }, 'Add by hand');
  const screen = h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/add?kind=providers&from=models' }, '← Add')),
    h('h1', { class: 'title', text: src?.name ?? 'Add a provider' }),
    panel ? h('section', { class: 'panel', 'aria-label': src.name }, panel) : null,
    h('section', { class: 'panel', 'aria-label': 'By hand' },
      panel ? h('p', { class: 'sub', text: `Or add ${src.name} as it is, and set up its key and what it offers on its own page.` }) : null,
      src ? h('div', { class: 'acts' }, byHand) : null,
      status));
  // Left for another screen, not drawn again: what Add's tap brought goes if unused.
  whenGone(screen, () => {
    if (new URLSearchParams(location.hash.split('?')[1] ?? '').get('new') !== pluginId) ctx.llm.leaveAdd(pluginId).catch((/** @type {unknown} */ e) => console.warn("a provider plugin with no provider couldn't be removed", e));
  });
  return screen;
}

/**
 * What a provider's page says when its plugin isn't running, in words with no plugin id (fixes-ui 16): installed, a link to it;
 * annai's own and missing (a restore brings providers back without theirs), Install it, here; another's, that annai can't fetch it.
 * @param {any} ctx @param {string} plugin @param {any} installed its install state, if any
 */
async function missingPlugin(ctx, plugin, installed) {
  if (installed) {
    return h('p', { class: 'risk-note' }, `Its plugin, ${installed.name}, isn't running, so annai can't say what it offers. `,
      h('a', { href: `#/plugins/${encodeURIComponent(plugin)}` }, 'Look at it in Settings → Plugins'), '.');
  }
  const catalog = await officialPlugins().catch(() => null);
  const entry = catalog?.find((/** @type {any} */ p) => p.id === plugin);
  if (!entry) {
    return h('p', { class: 'risk-note', text: catalog ? "The plugin it was made from isn't on this device, and it isn't one of annai's own, so annai can't fetch it. Install it again from where you got it, in Settings → Plugins → Add, or remove this provider."
      : "Its plugin isn't on this device, and annai's catalog couldn't be loaded to fetch it. Connect to the internet and open this page again." });
  }
  const status = h('p', { class: 'sub', role: 'status' });
  const install = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      install.disabled = true;
      status.textContent = 'Installing…';
      try {
        await ctx.llm.installProvider(plugin, { official: true });
        ctx.render();
      } catch (e) {
        status.textContent = messageOf(e);
        install.disabled = false;
      }
    },
  }, 'Install it');
  return h('div', { class: 'risk-note' }, h('p', { text: `Its plugin, ${entry.name}, isn't installed, so annai can't say what it offers.` }), h('div', { class: 'acts' }, install), status);
}

/** @typedef {{ ctx: any, id: string, tunablesFor: (type: string) => Record<string, any>, desc: any }} View */

/**
 * Saves fields into the user's layer of the provider, or of one ability, as it is now (a function works
 * a value out from it), and puts its models back in use: what failed may be fixed. Gives what it saved.
 * @param {any} ctx @param {string} id @param {(type: string) => Record<string, any>} tunablesFor @param {string | null} abilityId
 * @returns {(fields: Record<string, any>) => Promise<any>}
 */
const saver = (ctx, id, tunablesFor, abilityId) => async (fields) => {
  const now = (await ctx.llm.config()).providers[id];
  if (!now) throw new Error('This provider no longer exists.');
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
  const type = ctx.llm.types().get(a.type);
  const body = h('div', {});
  // replaceChildren, unlike h, would show a null as the word.
  const draw = async () => body.replaceChildren(...(await abilityBody(view, abilityId)).filter((n) => n !== null));
  const use = savedCheck(`Use ${a.name}`, a.on, async (on) => {
    await ctx.llm.setAbility(id, abilityId, on);
    await draw();
  });
  await draw();
  return h('section', { class: 'panel', 'aria-label': a.name, onredraw: draw },
    h('h2', { class: 'section', text: a.name }),
    h('p', { class: 'sub', text: [type?.name ?? a.type, added && !a.on ? 'New in the last update' : null].filter(Boolean).join(' · ') }),
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
  if (!type) return [installPanel(ctx, a.type, () => ctx.render()), note];
  const saveAbility = saver(ctx, id, tunablesFor, abilityId);
  // Its own address, not the provider's it falls back to.
  const own = String(mergePatch(rec.template?.values?.abilities?.[abilityId] ?? {}, rec.user?.abilities?.[abilityId] ?? {}).baseUrl ?? '');
  const address = h('input', { id: `ability-${abilityId}-url`, autocomplete: 'off', autocapitalize: 'off', inputmode: 'url', value: own, placeholder: `the provider's: ${providerOf(rec).baseUrl || 'none yet'}` });
  // A new address lets go of what the provider keeps at the old one, so it warns as the provider's own address does (verification).
  const addressWarn = h('p', { class: 'sub' });
  if (type.keeps) address.addEventListener('input', () => warnKept(ctx, addressWarn, { provider: id }, true));
  const tunables = jsonField('Tunables (JSON)', `ability-${abilityId}-tunables`, a.tunables);
  const extra = jsonField('Extra request fields (JSON)', `ability-${abilityId}-extra`, a.extraBody);
  // Where the protocol stores files, photos go there once, then by id (spec §4.8). The switch is a tunable.
  const uploads = type.uploadRequest ? savedCheck('Upload photos to this provider (each expires after 48 hours)', a.tunables?.uploads !== false,
    async (on) => tunables.show((await saveAbility({ tunables: (/** @type {any} */ was) => ({ ...was.tunables, uploads: on }) })).tunables)) : null;
  // Where the protocol can, the provider keeps the conversation between turns (G2): a tunable too. Off, what it keeps is deleted.
  const who = type.keeps?.name ?? providerOf(rec).name;
  const keep = type.keeps ? savedCheck(`Let ${who} keep the conversation between turns: sends less each time.`, a.tunables?.keep !== false, async (on) => {
    tunables.show((await saveAbility({ tunables: (/** @type {any} */ was) => ({ ...was.tunables, keep: on }) })).tunables);
    if (!on) await ctx.llm.forgetEndpoint(`${id}/${abilityId}`);
  }) : null;
  const waiting = keep ? (await ctx.llm.keptCount({ endpoint: `${id}/${abilityId}` })).waiting : 0;
  const keyless = waiting > 0 && !(await ctx.llm.keyFor(id));
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
    h('div', { class: 'saving' }, field('Its own address', address), ...autosave(address, () => {
      const v = address.value.trim();
      const wrong = v ? addressProblem(v) : null;
      if (wrong) throw new Error(wrong);
      return v;
    }, (v) => (keep ? ctx.llm.reconnect(id, () => saveAbility({ baseUrl: v })) : saveAbility({ baseUrl: v })))), // a new address: what it keeps there goes first
    h('p', { class: 'sub', text: "Empty: the provider's address. Each setting here is saved as you change it." }),
    addressWarn,
    uploads?.el ?? null,
    keep?.el ?? null,
    keep ? h('p', { class: 'sub', text: `${who} keeps your conversations with Shiori, with their photos, voice messages and where you are as she knows it: a day on a free key, up to ${type.keeps.days} days on a paid one. annai deletes them when you remove their trip, this provider or everything (Erase), change or remove its key, or turn this off. Off, each turn sends the whole conversation.` }) : null,
    waiting ? h('p', { class: 'sub', text: `${waiting} deletion${waiting === 1 ? '' : 's'} waiting: ${keyless ? `annai can't send ${waiting === 1 ? 'it' : 'them'} without this provider's key` : `annai sends ${waiting === 1 ? 'it' : 'them'} when it can reach ${who}`}.` }) : null,
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
    first && speech ? speechTestPanel(ctx, first, speech, cfg.models[first.id].verified, `Test ${first.name}`) : null,
    first && !speech ? testPanel(ctx, first.id, cfg.models[first.id].verified, `Test ${first.name}`, a.kind === 'realtime') : null,
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
  return [...new Map(models.flatMap((m) => m.providerTools ?? []).filter((t) => t.label).map((t) => [t.id, t])).values()].flatMap((t) => {
    const out = Boolean(t.paidOnly && free);
    const sw = savedCheck(String(t.label), !out && switches[`provider:${t.id}`] !== false, (/** @type {boolean} */ v) => setToolSwitch(ctx.ws, `provider:${t.id}`, v));
    sw.input.disabled = out;
    return [sw.el, h('p', { class: 'sub', text: out ? `${who} doesn't offer ${t.kind === 'other' ? t.name : t.kind} on the free tier.` : t.note ?? '' })];
  });
}

/** "Install it" for a protocol that isn't running (a setup action, decision 9). @param {any} ctx @param {string} typeId @param {() => unknown} done */
function installPanel(ctx, typeId, done) {
  const status = h('p', { class: 'sub', role: 'status', text: `This needs the plugin for "${typeId}", which isn't running.` });
  const btn = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      btn.disabled = true;
      status.textContent = 'Installing…';
      try {
        await ctx.llm.ensureType(typeId);
        done();
      } catch (e) {
        status.textContent = messageOf(e);
        btn.disabled = false;
      }
    },
  }, 'Install it');
  return h('div', {}, status, h('div', { class: 'acts' }, btn));
}

/** An ability's models, Add a model by id and Fetch model list. @param {any} ctx @param {string} id @param {string} abilityId @param {import('../../core/llm/config.js').Model[]} models */
function modelsPart(ctx, id, abilityId, models) {
  const status = h('p', { class: 'sub', role: 'status' });
  const listSlot = h('div', {});
  const providerId = h('input', { id: `model-id-${abilityId}`, autocomplete: 'off', autocapitalize: 'off', placeholder: "the provider's model id" });
  const add = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const value = providerId.value.trim();
      if (!value) return;
      try {
        await addModelById(ctx, id, abilityId, value);
        ctx.render();
      } catch (e) {
        status.textContent = messageOf(e);
      }
    },
  }, 'Add model');
  const fetchList = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      fetchList.disabled = true;
      status.textContent = 'Asking for its models…';
      try {
        const listed = await ctx.llm.listModels(id, abilityId);
        status.textContent = `${listed.length} model${listed.length === 1 ? '' : 's'}.`;
        listSlot.replaceChildren(listedModels(ctx, id, abilityId, listed, models, await ctx.llm.config()));
      } catch (e) {
        status.textContent = messageOf(e);
      } finally {
        fetchList.disabled = false;
      }
    },
  }, 'Fetch model list');
  const rows = models.map((m) => h('li', {}, h('a', { class: 'card', href: `#/models/model?id=${encodeURIComponent(m.id)}` },
    h('span', { class: 'name', text: m.name }),
    h('span', { class: 'sub', text: [m.providerId !== m.name ? m.providerId : null, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : null, priceLine(m.prices)].filter(Boolean).join(' · ') }))));
  return h('div', {},
    h('h3', { text: 'Its models' }),
    rows.length ? h('ul', { class: 'cards' }, ...rows) : h('p', { class: 'empty', text: 'No models yet.' }),
    h('div', { class: 'row' }, field('Add a model by id', providerId), h('div', { class: 'acts' }, add, fetchList)),
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
  const filter = h('input', { id: `model-filter-${abilityId}`, autocomplete: 'off', placeholder: 'for example: haiku' });
  const list = h('ul', { class: 'listed' });
  const show = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = listed.filter((m) => !owned.has(m.providerId) && (!q || `${m.providerId} ${m.name ?? ''}`.toLowerCase().includes(q))).slice(0, 50);
    list.replaceChildren(...rows.map((m) => {
      const on = taken.get((m.name || m.providerId).toLowerCase());
      const { loaded, ...model } = m; // said here, never kept on the model
      return h('li', { class: 'acts' },
        h('span', { text: `${m.name && m.name !== m.providerId ? `${m.name} (${m.providerId})` : m.providerId}${loaded ? ' · loaded' : ''}` }),
        on !== undefined ? h('span', { class: 'sub', text: `Already added, on ${on || 'another provider'}` }) : h('button', {
          class: 'btn', type: 'button', 'aria-label': `Add ${m.providerId}`,
          onclick: async () => {
            await addListedModel(ctx, id, abilityId, model);
            ctx.render();
          },
        }, 'Add'));
    }));
  };
  filter.addEventListener('input', show);
  show();
  return h('div', {}, field('Filter the list', filter), list);
}

/** Buttons that put a provider's suggested models in the roles ("free", "recommended"). @param {any} ctx @param {string} id @param {import('../../core/llm/providers.js').ProviderSource} src */
function suggestionsPanel(ctx, id, src) {
  const roles = src.provider.roles ?? {};
  const speech = Object.values(roles).some((r) => SPEECH_ROLES.some((role) => role in r));
  /** @type {Record<string, string>} */
  const labels = { free: 'Use the free models', recommended: 'Use the recommended models' };
  return h('section', { class: 'panel', 'aria-label': 'Suggested models' },
    h('p', { class: 'sub', text: `${src.name} suggests a model for each role.${speech ? " Its speech models then go ahead of the phone's own dictation and the browser voice, which are free, so any that cost money are tried before them." : ''}` }),
    h('div', { class: 'acts' }, ...Object.keys(roles).map((which) => h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          // What it switched on, or couldn't, said after the roles.
          const r = await ctx.llm.useSuggestion(id, which);
          ctx.notices.toast(['Roles updated.', ...r.on.map((/** @type {string} */ n) => `${n} switched on.`),
            ...r.failed.map((/** @type {any} */ f) => `${f.name} couldn't be switched on: ${messageOf(f.error)}`)].join(' '));
        } catch (e) {
          ctx.notices.toast(messageOf(e));
        }
        ctx.render();
      },
    }, labels[which] ?? `Use the ${which} models`))));
}
