import { h, field, autosave, savedRadios } from '../dom.js';
import { toolList, toolSwitches, setToolSwitch, ALWAYS_ON } from '../../core/agent/tools.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { modelOf } from '../../core/llm/config.js';

const GROUPS = ['Talk', 'Files', 'Web', 'Places', 'Go', 'Time', 'Self'];
/** Jina's page for its API keys ("Manage API Key"), where a free key is made. */
const JINA_KEYS = 'https://jina.ai/api-dashboard/key-manager/';

/** A switch for every tool and provider-side tool (spec §7.2, §9.5); switches cover plugins' tools too. @param {any} ctx */
export async function toolSwitchList(ctx) {
  const switches = await toolSwitches(ctx.ws);
  const all = toolList({ registry: ctx.registry, switches: {}, loop: ctx.agent?.loopTools?.() ?? [] });
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const t of all) {
    // An MCP server's tools have a group of their own (milestone 8c): "MCP: <server>".
    const g = t.group && (GROUPS.includes(t.group) || String(t.group).startsWith('MCP: ')) ? t.group : `Plugin: ${t.pluginId}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)?.push(t);
  }
  const cfg = await ctx.llm.config();
  /** @type {Map<string, { id: string, name: string, models: string[] }>} */
  const provider = new Map();
  for (const rec of Object.values(cfg.models)) {
    const m = modelOf(/** @type {any} */ (rec));
    for (const t of m.providerTools ?? []) {
      const p = provider.get(t.id) ?? { id: t.id, name: t.name, models: [] };
      p.models.push(m.name);
      provider.set(t.id, p);
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
    ...ordered.map((g) => h('div', {}, h('h3', { text: g }), h('ul', { class: 'file-list' },
      ...(groups.get(g) ?? []).map((t) => sw(t.name, t.name, t.name === 'speak' ? '(off means voice off)' : ALWAYS_ON.includes(t.name) ? '(always on)' : '', ALWAYS_ON.includes(t.name)))))),
    provider.size ? h('div', {}, h('h3', { text: "Your models' own tools" }), h('ul', { class: 'file-list' },
      ...[...provider.values()].map((p) => sw(`provider:${p.id}`, p.name, `(${p.models.join(', ')})`)))) : null);
}

/** Settings → Tools. @param {any} ctx */
export async function renderTools(ctx) {
  const app = await readAppSettings(ctx.ws);
  const web = app.web ?? {};
  const hasKey = Boolean(await ctx.store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret('plugin:web:jina')));
  const key = h('input', { id: 'jina-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: hasKey ? 'A key is set' : 'jina_…' });
  const saveWeb = (/** @type {Record<string, any>} */ c) => updateAppSettings(ctx.ws, { web: c });
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/settings' }, '← Settings')),
    h('h1', { class: 'title', text: 'Tools' }),
    h('section', { class: 'panel', 'aria-label': 'Web' },
      h('h2', { class: 'section', text: 'Web' }),
      savedRadios('Search via', [['auto', "Your model's own search when it has one, else Jina"], ['provider', "Your model's own search"], ['annai', 'Jina Search (needs the key below)'], ['off', 'Off']], web.searchVia ?? 'auto', (v) => saveWeb({ searchVia: v })),
      savedRadios('Fetch via', [['annai', 'annai: directly, then Jina Reader, then your model'], ['provider', "Your model's own fetch"], ['off', 'Off']], web.fetchVia ?? 'annai', (v) => saveWeb({ fetchVia: v })),
      field('Jina key', key),
      hasKey
        ? h('p', { class: 'sub', text: 'A key is set. It stays on this device and is never shown again.' })
        // A real link, so an iPhone Home Screen app opens it in Safari from the tap itself (as Sign in with OpenRouter does).
        : h('p', { class: 'sub' }, "Jina Reader reads sites that don't let web apps read them, and Jina Search searches the web. Some networks need a key. ",
          h('a', { href: JINA_KEYS, target: '_blank', rel: 'noopener noreferrer', text: 'Get a free key from Jina' }), '.'),
      h('div', { class: 'acts' },
        h('button', { class: 'btn pri', type: 'button', onclick: async () => {
          const v = key.value.trim();
          if (!v) return;
          await ctx.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.putSecret('plugin:web:jina', v));
          ctx.notices.toast('Key saved.');
          ctx.render();
        } }, 'Save key'),
        hasKey ? h('button', { class: 'btn', type: 'button', onclick: async () => { await ctx.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.deleteSecret('plugin:web:jina')); ctx.render(); } }, 'Remove key') : null)),
    h('section', { class: 'panel', 'aria-label': 'MCP servers' },
      h('h2', { class: 'section', text: 'MCP servers' }),
      h('p', { class: 'sub', text: 'Servers that give Shiori tools of their own, with a token or headers kept on this device.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/mcp' }, 'MCP servers'))),
    h('section', { class: 'panel', 'aria-label': 'Tool switches' },
      h('h2', { class: 'section', text: 'Tool switches' }),
      h('p', { class: 'sub', text: 'Every tool Shiori has, including plugins\' tools. A switched-off tool is left out of her next request.' }),
      await toolSwitchList(ctx)));
}
