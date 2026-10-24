import { h, field, autosave, savedRadios, savingNote, t, tc } from '../dom.js';
import { toolList, toolSwitches, setToolSwitch, ALWAYS_ON } from '../../core/agent/tools.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { modelOf, providerOf } from '../../core/llm/config.js';
import { searchPanel } from '../search-panel.js';
import { list } from '../format.js';

/** The built-in tools' groups in order, as their plugins name them. */
const GROUPS = /* en */ ['Talk', 'Files', 'Web', 'Places', 'Go', 'Time', 'Self'];
/** The groups in the screens' words. @type {Record<string, string>} */
const GROUP_NAMES = { Talk: tc('tool group')`Talk`, Files: tc('tool group')`Files`, Web: tc('tool group')`Web`, Places: tc('tool group')`Places`, Go: tc('tool group')`Go`, Time: tc('tool group')`Time`, Self: tc('tool group')`Self` };
/** Jina's main page, which shows the key to copy in its API box (the user, 2026-10-23: its API page "will not give you a copiable api there while the main page does"). */
const JINA_KEYS = 'https://jina.ai/';

/** A switch for every tool and provider-side tool (spec §7.2, §9.5); switches cover plugins' tools too. @param {any} ctx */
export async function toolSwitchList(ctx) {
  const switches = await toolSwitches(ctx.ws);
  const all = toolList({ registry: ctx.registry, switches: {}, loop: ctx.agent?.loopTools?.() ?? [] });
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const tool of all) {
    // An MCP server's tools have a group of their own (milestone 8c): "MCP: <server>".
    const g = tool.group && (GROUPS.includes(tool.group) || String(tool.group).startsWith('MCP: ')) ? tool.group : t`Plugin: ${tool.pluginId}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)?.push(tool);
  }
  const cfg = await ctx.llm.config();
  /** @type {Map<string, { id: string, name: string, models: string[] }>} */
  const provider = new Map();
  for (const rec of Object.values(cfg.models)) {
    const m = modelOf(/** @type {any} */ (rec));
    const free = cfg.providers[m.provider] ? providerOf(cfg.providers[m.provider]).free : false;
    for (const pt of m.providerTools ?? []) {
      if (pt.paidOnly && free) continue; // not on a key on the free tier (G4)
      const p = provider.get(pt.id) ?? { id: pt.id, name: pt.name, models: [] };
      p.models.push(m.name);
      provider.set(pt.id, p);
    }
  }
  /** @param {string} key @param {string} label @param {string} [note] @param {boolean} [fixed] */
  const sw = (key, label, note, fixed = false) => {
    const input = h('input', { type: 'checkbox', checked: fixed || switches[key] !== false, disabled: fixed });
    return h('li', { class: 'saving' }, h('label', { class: 'check' }, input, h('span', { text: label }), note ? h('span', { class: 'sub', text: ` ${note}` }) : null),
      ...autosave(input, () => input.checked, (on) => setToolSwitch(ctx.ws, key, on)));
  };
  const ordered = [...GROUPS.filter((g) => groups.has(g)), ...[...groups.keys()].filter((g) => !GROUPS.includes(g))];
  return h('div', { class: 'tool-switches' },
    ...ordered.map((g) => h('div', {}, h('h3', { text: GROUP_NAMES[g] ?? g }), h('ul', { class: 'file-list' },
      ...(groups.get(g) ?? []).map((tool) => sw(tool.name, tool.name, tool.name === 'speak' ? t`(off means voice off)` : ALWAYS_ON.includes(tool.name) ? t`(always on)` : '', ALWAYS_ON.includes(tool.name)))))),
    provider.size ? h('div', {}, h('h3', { text: t`Your models' own tools` }), h('ul', { class: 'file-list' },
      ...[...provider.values()].map((p) => sw(`provider:${p.id}`, p.name, t`(${list(p.models, 'plain')})`)))) : null);
}

/** Where to get a Jina key; the link is a value of the message. */
function jinaNote() {
  const get = t`Get a free key from Jina`;
  const [before, after] = t`Jina Reader reads sites that don't let web apps read them, and Jina Search searches the web. Some networks need a key. ${get}. On that page the key is in the API key box: copy it and paste it above.`.split(get);
  return h('p', { class: 'sub' }, before, h('a', { href: JINA_KEYS, target: '_blank', rel: 'noopener noreferrer', text: get }), after);
}

/** Settings → Tools. @param {any} ctx */
export async function renderTools(ctx) {
  const app = await readAppSettings(ctx.ws);
  const web = app.web ?? {};
  const hasKey = Boolean(await ctx.store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret('plugin:web:jina')));
  const key = h('input', { id: 'jina-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: hasKey ? t`A key is set` : /* en */ 'jina_…' });
  const saving = h('span', { class: 'sub', role: 'status' });
  const saveWeb = (/** @type {Record<string, any>} */ c) => updateAppSettings(ctx.ws, { web: c });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: t`Tools` }),
    h('section', { class: 'panel', 'aria-label': t`Web` },
      h('h2', { class: 'section', text: t`Web` }),
      savedRadios(t`Search via`, [['auto', t`Your model's own search when it has one, else annai's providers (below)`], ['provider', t`Your model's own search`], ['annai', t`annai's providers (below)`], ['off', t`Off`]], web.searchVia ?? 'auto', (v) => saveWeb({ searchVia: v })),
      savedRadios(t`Fetch via`, [['annai', t`annai: directly, then Jina Reader, then Exa, then your model`], ['provider', t`Your model's own fetch`], ['off', t`Off`]], web.fetchVia ?? 'annai', (v) => saveWeb({ fetchVia: v })),
      field(t`Jina key`, key),
      // A real link, so an iPhone Home Screen app opens it in Safari from the tap itself (as a provider's sign-in does).
      hasKey ? h('p', { class: 'sub', text: t`A key is set. It stays on this device and is never shown again.` }) : jinaNote(),
      h('div', { class: 'acts' },
        h('button', { class: 'btn pri', type: 'button', onclick: () => {
          const v = key.value.trim();
          if (!v) return;
          return savingNote(saving, () => ctx.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.putSecret('plugin:web:jina', v)), async () => {
            await ctx.render();
            ctx.notices.toast(t`Key saved.`);
          });
        } }, t`Save key`),
        saving,
        hasKey ? h('button', { class: 'btn', type: 'button', onclick: async () => { await ctx.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.deleteSecret('plugin:web:jina')); ctx.render(); } }, t`Remove key`) : null)),
    await searchPanel(ctx),
    h('section', { class: 'panel', 'aria-label': t`MCP servers` },
      h('h2', { class: 'section', text: t`MCP servers` }),
      h('p', { class: 'sub', text: t`Servers that give Shiori tools of their own, with a token or headers kept on this device.` }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/mcp' }, t`MCP servers`))),
    h('section', { class: 'panel', 'aria-label': t`Tool switches` },
      h('h2', { class: 'section', text: t`Tool switches` }),
      h('p', { class: 'sub', text: t`Every tool Shiori has, including plugins' tools. A switched-off tool is left out of her next request.` }),
      await toolSwitchList(ctx)));
}
