import { utf8 } from '../../src/core/bytes.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { watchAppends, deliverHooks } from '../../src/core/hooks.js';

/** A package's files from texts, by name. @param {Record<string, string>} o */
export const files = (o) => new Map(Object.entries(o).map(([k, v]) => [k, utf8(v)]));

/** A third party's skill, as its SKILL.md. */
export const SKILL = '---\nname: tide-pools\ndescription: Tide pools: when they are safe to visit.\nmetadata:\n  author: Example Trails\n  version: "1.2"\n---\n# Tide pools\nSee [safety](references/safety.md).\n';

/** A model provider's description, as data: one chat ability. */
export const TRAIL_LLM = Object.freeze({ baseUrl: 'https://llm.trails.example/v1', key: 'required', abilities: { chat: { kind: 'chat', type: 'chat-completions' } } });

/** A package without code: a skill, a personality and a model provider. @param {any} [more] manifest changes */
export const KIT = (more = {}) => files({
  'annai-plugin.json': JSON.stringify({ id: 'trail-kit', name: 'Trail kit', version: '1.0.0', api: 1, skills: ['skills/trail-safety'], personalities: ['personalities/ranger.md'], provider: TRAIL_LLM, ...more }),
  'skills/trail-safety/SKILL.md': '---\nname: trail-safety\ndescription: Before a hike, what to check.\n---\nCarry water.',
  'personalities/ranger.md': '# Ranger\nCalm and practical.',
});

/** A code plugin: its activate() is body. @param {string} id @param {string} body @param {any} [more] manifest changes */
export const codePlugin = (id, body, more = {}) => files({
  'annai-plugin.json': JSON.stringify({ id, name: id[0].toUpperCase() + id.slice(1), version: '1.0.0', api: 1, entry: 'index.js', ...more }),
  'index.js': `export function activate(annai) { ${body} }`,
});

/** A built-in plugin's module, as a data: address addBuiltin can import. @param {string} id @param {string} body its activate() */
export const builtinUrl = (id, body) => `data:text/javascript;base64,${Buffer.from(`export const manifest = ${JSON.stringify({ id, name: `Built-in ${id}`, version: '1.0.0', api: 1 })};
export function activate(annai) { ${body} }`).toString('base64')}`;

/** A host on memory storage, its log appends handed to plugins' hooks, that loads installed modules from storage as data: URLs (as plugins.test.js does). */
export async function hostKit() {
  const registry = new Registry();
  const store = watchAppends(createMemoryStore(), (evs) => deliverHooks(registry, evs));
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const host = new PluginHost({ registry, workspace: ws, importModule });
  const log = () => store.tx(['events'], 'readonly', (t) => t.listEvents(SYS));
  return { registry, store, ws, host, importModule, log, relaunch: () => new PluginHost({ registry: new Registry(), workspace: ws, importModule }) };
}
