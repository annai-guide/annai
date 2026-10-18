import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { SYS } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';

/** Starts a built-in test plugin and returns the annai object it was given. @param {any} k */
async function api(k) {
  /** @type {any} */
  let got = null;
  const url = `data:text/javascript;base64,${Buffer.from(`export const manifest = { id: 'probe', name: 'Probe', version: '1.0.0', api: 1 }; export function activate(a) { globalThis.__probe = a; }`).toString('base64')}`;
  await k.host.addBuiltin(url);
  got = /** @type {any} */ (globalThis).__probe;
  return got;
}

test('plugins can call models, decide, wake Shiori, fetch (traced), show cards, read the cache and keep settings (spec §5.4)', async () => {
  const k = await agentKit([[{ text: 'Plugin reply.' }, { toolCalls: [{ name: 'sleep', input: {} }] }]]);
  /** @type {any[]} */
  const cards = [];
  k.host.connect({ llm: { ...k.llm, decide: async () => ({ a: 0.9, b: 0.1 }) }, agent: k.agent, notices: { card: (/** @type {any} */ c) => cards.push(c), toast: () => {} } });
  const a = await api(k);
  assert.equal((await a.llm('main', { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] })).text, 'Plugin reply.');
  const [turn] = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.equal(turn.data.tag, 'plugin:probe');
  // Fix pass 8b-1: the model requests a plugin causes carry it too, so its hooks never get them.
  const requests = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }));
  assert.ok(requests.length && requests.every((e) => e.data.tag === 'plugin:probe'), JSON.stringify(requests.map((e) => e.data.tag)));
  assert.deepEqual(await a.llm.decide({ prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), { a: 0.9, b: 0.1 });
  a.wake('Low tide in 30 minutes.');
  await k.agent.idle();
  assert.equal((await k.events(['wake']))[0].data.reasons[0].plugin, 'probe');
  assert.equal(a.cache.state()?.warm, true);
  a.ui.card({ title: 'Tides', body: 'Low at 4:12' });
  assert.equal(cards[0].title, 'Tides');
  await a.settings.set({ station: '9413450' });
  assert.deepEqual(await a.settings.get(), { station: '9413450' });
});

test('plugin requests are traced; log entries keep their content as named blobs', async () => {
  const k = await agentKit([[{ text: 'x' }]]);
  k.host.connect({ llm: k.llm, agent: k.agent, notices: { card: () => {}, toast: () => {} }, fetch: async () => new Response('ok') });
  const a = await api(k);
  await a.net.fetch('https://tides.test/api?station=1&token=abcd1234');
  const [req] = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }));
  assert.equal(req.data.tool, 'plugin:probe');
  assert.match(req.data.url, /token=%C2%ABkey%C2%BB/);
  const ev = await a.events.append(k.trip, 'tides.table', { station: '1' }, { texts: [['table', 'x'.repeat(3000)]] });
  assert.equal(ev.refs.length, 1);
  assert.deepEqual(ev.data.stored, ['table']);
});

test('search providers in the order the settings give', async () => {
  const k = await agentKit([[{ text: 'x' }]]);
  k.host.connect({ llm: k.llm, agent: k.agent, notices: { card: () => {}, toast: () => {} } });
  const a = await api(k);
  k.registry.add('one', 'search', { id: 'one', name: 'One', search: async () => [] });
  k.registry.add('two', 'search', { id: 'two', name: 'Two', search: async () => [] });
  assert.deepEqual(a.searchProviders().map((/** @type {any} */ p) => p.id), ['one', 'two']);
  await updateAppSettings(k.ws, { web: { search: ['two', 'one'] } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual((await a.searchProvidersAsync()).map((/** @type {any} */ p) => p.id), ['two', 'one']);
});

test("annai.secrets.blank gives a copy with every secret annai keeps, and anything shaped like a credential, blanked in every string, however deep; other text and values are unchanged", async () => {
  const k = await agentKit([[{ text: '' }]]);
  const KEY = 'sk-planted-endpoint-key-0123456789';
  await k.store.tx(['secrets'], 'readwrite', async (t) => {
    await t.putSecret('endpoint:stand-in:key', KEY);
    await t.putSecret('plugin:other:token', { token: 'other-plugins-token-abcdef' });
  });
  const a = await api(k);
  const value = Object.freeze({
    text: `key ${KEY}, in an address ${encodeURIComponent(`?k=${KEY}`)}`,
    deep: [{ error: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 refused', n: 3 }, 'OTHER-PLUGINS-TOKEN-ABCDEF', null, true],
    plain: 'Low tide at 5:40, page=2',
  });
  const out = await a.secrets.blank(value);
  assert.deepEqual(out, {
    text: 'key «key», in an address %3Fk%3D«key»',
    deep: [{ error: 'Authorization: Bearer «key» refused', n: 3 }, '«key»', null, true],
    plain: 'Low tide at 5:40, page=2',
  });
  assert.notEqual(out, value, 'a copy');
  assert.equal(await a.secrets.blank('nothing secret here'), 'nothing secret here');
  assert.equal(await a.secrets.blank(42), 42);
});
