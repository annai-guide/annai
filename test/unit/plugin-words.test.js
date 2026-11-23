import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { hostKit, codePlugin, builtinUrl, storedModules } from './package-kit.js';
import { useClock } from './clock.js';
import { keysUnread } from '../fakes/store-memory.js';
import { utf8, text } from '../../src/core/bytes.js';
import { normalizeRows } from '../../src/core/web-search.js';

// What a plugin that isn't built into annai hands it for Shiori or the log has every key annai keeps blanked, at the plugin host's API
// (plugins.js): a tool's text, a search provider's rows, a wake's reason, a log entry's words (plugin-words-next). A built-in's are as they are.

const KEY = 'Tr4il key/9876+x'; // made up; URL-encoding changes its space, slash and plus
/** A text as a form encodes it ("+" for a space). @param {string} s */
const formOf = (s) => new URLSearchParams({ s }).toString().slice(2);
const ONCE = [KEY, encodeURIComponent(KEY), formOf(KEY), encodeURI(KEY)];
/** The key as a service may echo it: as written, as a URL component, a whole address or a form encodes it, and each of those encoded once more. */
const FORMS = [...new Set([...ONCE, ...ONCE.flatMap((f) => [encodeURIComponent(f), formOf(f)])])];
/** The same in capitals, and with lower-case escapes: a service's own case. */
const CASES = [encodeURIComponent(KEY).toUpperCase(), encodeURIComponent(KEY).toLowerCase()];
/** A trail service's answer with the key in each of those forms, and once inside another address's parameter; `of` gives what stands for the key. @param {(form: string) => string} of */
const linked = (of = (f) => f) => [
  ...[...FORMS, ...CASES].map((f, i) => `link ${i + 1}: https://api.trails.example/v1/trails?k=${of(f)}`),
  `map: https://go.example/?to=${encodeURIComponent('https://api.trails.example/v1/map?key=')}${of(encodeURIComponent(encodeURIComponent(KEY)))}`,
].join('; ');
const BLANKED = linked(() => '«key»');
const NOTE = "annai couldn't check this message for keys, so it is not shown.";
const say = (/** @type {string} */ words) => ({ toolCalls: [{ name: 'speak', input: { text: words } }, { name: 'sleep', input: {} }] });
const services = (/** @type {any} */ k) => k.host.connect({ llm: k.llm, agent: k.agent, notices: { card: () => {}, toast: () => {} } });
/** Whether any form of the key is in a value, whatever its case. @param {any} v */
const holdsKey = (v) => [...FORMS, ...CASES].some((f) => JSON.stringify(v).toLowerCase().includes(f.toLowerCase()));

for (const unread of [false, true]) {
  test(`a third-party plugin's tool result repeating its key: what she reads and the trace's tool result hold «key»${unread ? ", and the note when annai can't read the keys" : ''}; a file holding the key, read with annai's own files tool, is as it is (plugin-words-next)`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [{ name: 'trail_list', input: {} }, { name: 'read', input: { path: '/trip/keys.md' } }] }, say('Two trails.')]]);
    k.host.importModule = storedModules(k.ws);
    await k.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:trails:key', KEY));
    await k.ws.write(k.trip, '/keys.md', `My trail key: ${KEY}`, { author: 'user', type: 'text/markdown' });
    await k.host.install(codePlugin('trails', `annai.tools.register({ name: 'trail_list', description: 'Trails.', input: { type: 'object' }, run: () => ${JSON.stringify(`Two trails. ${linked()}`)} });`));
    await k.host.start('trails');
    const back = unread ? keysUnread(k.store) : () => {};
    k.agent.send('Which trails are open?');
    await k.agent.idle();
    back();
    const kept = Object.fromEntries((await k.events(['tool.result'])).map((e) => [e.data.name, e.data.content]));
    const read = Object.fromEntries(k.requests[1].messages.at(-1).parts.filter((/** @type {any} */ p) => p.type === 'tool_result').map((/** @type {any} */ p, /** @type {number} */ i) => [['trail_list', 'read'][i], p.content]));
    const want = unread ? NOTE : `Two trails. ${BLANKED}`;
    assert.equal(kept.trail_list, want);
    assert.equal(read.trail_list, want);
    // Her own files tool reads the file as it is (annai's tool, not the plugin's): what she reads and the trace's result hold the traveller's own key.
    for (const r of [kept.read, read.read]) assert.ok(r.includes(`My trail key: ${KEY}`), r);
  });
}

test("a third-party plugin's wake and log entry hold «key» where its words held its key (its object keys too), in the wake Shiori reads and in the log; a blob stays as it was given; when annai can't read the keys, the note; a built-in's are as it gave them (plugin-words-next)", async (t) => {
  useClock(t);
  const k = await agentKit([[say('A trail is closed.'), say('Noted.'), say('Opened.')]]);
  k.host.importModule = storedModules(k.ws);
  services(k);
  await k.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:trails:key', KEY));
  await k.host.install(codePlugin('trails', 'globalThis.__trails = annai;'));
  await k.host.start('trails');
  await k.host.addBuiltin(builtinUrl('own-trails', 'globalThis.__ownTrails = annai;'));
  const { __trails: theirs, __ownTrails: own } = /** @type {any} */ (globalThis);
  const blob = utf8(`raw answer ${KEY}`);
  const seen = { [`https://api.trails.example/v1/trails?key=${encodeURIComponent(KEY)}`]: 'yesterday' };
  const append = (/** @type {any} */ a, /** @type {any} */ more = {}) => a.events.append(k.trip, 'trails.closed', { trail: 'Pine Ridge', why: `403 for ${linked()}`, ...more }, { texts: [['answer', `The service said: ${linked()}`]], blobs: [{ bytes: blob, type: 'text/plain' }] });
  /** What an entry holds: its data's words, its text and its blob. @param {any} e */
  const shown = async (e) => ({ why: e.data.why, answer: e.data.answer, blob: text(new Uint8Array((await k.store.tx(['blobs'], 'readonly', (t) => t.getBlob(e.refs[0])))?.data ?? new ArrayBuffer(0))), ...(e.data.seen ? { seen: e.data.seen } : {}) });
  assert.deepEqual(await shown(await append(theirs, { seen })), { why: `403 for ${BLANKED}`, answer: `The service said: ${BLANKED}`, blob: `raw answer ${KEY}`, seen: { 'https://api.trails.example/v1/trails?key=«key»': 'yesterday' } });
  assert.deepEqual(await shown(await append(own, { seen })), { why: `403 for ${linked()}`, answer: `The service said: ${linked()}`, blob: `raw answer ${KEY}`, seen });
  await theirs.wake(`The Pine Ridge trail closed (${linked()}).`);
  await k.agent.idle();
  const wakes = () => k.events(['wake']);
  assert.equal((await wakes())[0].data.reasons[0].text, `The Pine Ridge trail closed (${BLANKED}).`);
  assert.ok(JSON.stringify(k.requests[0].messages).includes(`The Pine Ridge trail closed (${BLANKED}).`));
  const back = keysUnread(k.store);
  try {
    assert.deepEqual(await shown(await append(theirs)), { why: NOTE, answer: NOTE, blob: `raw answer ${KEY}` });
    await theirs.wake(`The Ewoldsen trail closed (${linked()}).`);
    await k.agent.idle();
  } finally {
    back();
  }
  assert.equal((await wakes())[1].data.reasons[0].text, NOTE);
  assert.equal(holdsKey(k.requests), false, 'no form of the key reached her');
  own.wake(`The Ewoldsen trail opened (${linked()}).`);
  await k.agent.idle();
  assert.equal((await wakes())[2].data.reasons[0].text, `The Ewoldsen trail opened (${linked()}).`);
});

/** A host with the web tool and a trail search provider that answers `rows`; the tools by name. @param {any} rows */
async function searchKit(rows) {
  const { host, registry, store } = await hostKit();
  await store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:trail-search:key', KEY));
  await host.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  await host.install(codePlugin('trail-search', `annai.register('search', { id: 'trails', name: 'Trails', search: async () => ${JSON.stringify(rows)} });`));
  await host.start('trail-search');
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  const call = { scope: 'me', trip: null, signal: new AbortController().signal, model: { input: ['text'] }, wake: 'w', author: 'shiori', providerOff: [], fetch: async () => { throw new TypeError('Failed to fetch'); } };
  return { registry, store, tools, call };
}

test("a third-party search provider's rows repeating its key (in a title, an address, a snippet) hold «key» in what web_search gives Shiori; when annai can't read the keys, its rows are the note and no row reaches her (plugin-words-next)", async () => {
  const rows = [
    { title: 'Pine Ridge trail', url: `https://trails.example/pine-ridge?key=${encodeURIComponent(KEY)}`, snippet: `Open. Next: https://api.trails.example/v1/trails?k=${formOf(KEY)}` },
    { title: `Ewoldsen trail, key ${KEY}`, url: `https://trails.example/ewoldsen?to=${encodeURIComponent(`https://api.trails.example/v1?key=${encodeURIComponent(KEY)}`)}`, snippet: 'Closed.' },
  ];
  const { registry, store, tools, call } = await searchKit(rows);
  const out = await tools.web_search.run({ query: 'Big Sur trails' }, call);
  assert.equal(holdsKey(out), false, out);
  const lines = String(out).split('\n');
  assert.equal(lines[1].split('\t')[1], 'https://trails.example/pine-ridge?key=%C2%ABkey%C2%BB');
  assert.equal(lines[1].split('\t')[2], 'Open. Next: https://api.trails.example/v1/trails?k=«key»');
  assert.equal(lines[2].split('\t')[0], 'Ewoldsen trail, key «key»');
  assert.equal(lines[2].split('\t')[1], `https://trails.example/ewoldsen?${new URLSearchParams({ to: 'https://api.trails.example/v1?key=«key»' })}`);
  const provider = registry.entries('search').find((e) => e.item.id === 'trails')?.item;
  const back = keysUnread(store);
  try {
    const notes = await provider.search('Big Sur trails', { signal: call.signal, limit: 8 });
    assert.deepEqual(notes, rows.map(() => ({ title: NOTE, url: NOTE, snippet: NOTE })));
    assert.deepEqual(normalizeRows(notes, 'Big Sur trails'), [], 'no address: web_search asks the next provider');
    // web_search itself: the provider's rows are dropped, and nothing of them (the note included) is in what she reads.
    const said = await tools.web_search.run({ query: 'Big Sur trails' }, call).then(String, (/** @type {any} */ e) => String(e?.message ?? e));
    assert.ok(!said.includes('trails.example') && !said.includes('Pine Ridge') && !said.includes(NOTE) && !holdsKey(said), said);
  } finally {
    back();
  }
});

test("a third-party search provider keeps on its own `this` what its ready() learned, for its search() (plugin-words-next)", async () => {
  const { host, registry } = await hostKit();
  await host.addBuiltin(new URL('../../src/plugins/web/index.js', import.meta.url).href);
  await host.install(codePlugin('trail-search', `annai.register('search', { id: 'trails', name: 'Trails',
    ready() { this.session = 'learned-in-ready'; return { ok: true }; },
    async search(query) { return [{ title: 'Pine Ridge trail', url: 'https://trails.example/pine-ridge?session=' + this.session, snippet: 'Open.' }]; } });`));
  await host.start('trail-search');
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  const call = { scope: 'me', trip: null, signal: new AbortController().signal, model: { input: ['text'] }, wake: 'w', author: 'shiori', providerOff: [], fetch: async () => { throw new TypeError('Failed to fetch'); } };
  const out = await tools.web_search.run({ query: 'Big Sur trails' }, call);
  assert.equal(String(out).split('\n')[1].split('\t')[1], 'https://trails.example/pine-ridge?session=learned-in-ready');
});
