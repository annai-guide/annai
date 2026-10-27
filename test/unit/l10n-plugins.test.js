import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';
import { hostKit } from './package-kit.js';
import { startMcpServer } from '../fakes/mcp.js';
import { createTrip } from '../../src/core/scopes.js';
import { cooldowns } from '../../src/core/web-search.js';
import { NOMINATIM_GAP, nominatimReset } from '../../src/core/nominatim.js';

// The built-in plugins under Japanese screens (localization L5g). What a person reads (a plugin's name and description, the MCP
// servers screen's refusals, a search provider's state, the voice's failures) is in the screens' words; what Shiori reads (the tools'
// descriptions and schemas, what they answer and why they failed) stays English (localization design, section 7). The words are set
// before any plugin loads, as boot.js sets them before main.js, so words made at a module's top level are Japanese too.
setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));

/** Japanese: kana or kanji anywhere. */
const JA = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const BUILT_IN = ['core-schemas', 'files', 'web', 'places', 'go', 'skills', 'mcp'];
/** @param {string} id */
const at = (id) => new URL(`../../src/plugins/${id}/index.js`, import.meta.url).href;

async function kit() {
  const k = await hostKit();
  for (const id of BUILT_IN) await k.host.addBuiltin(at(id));
  const trip = await createTrip(k.ws, { title: 'Big Sur' });
  /** @param {string} name */
  const tool = (name) => k.registry.list('tool').find((/** @type {any} */ x) => x.name === name);
  /** A tool's run as the agent calls it, every request answered by answer. @param {string} name @param {any} input @param {(url: string, init?: any) => Response | Promise<Response>} answer */
  const run = (name, input, answer) => tool(name).run(input, {
    trip, scope: trip, signal: new AbortController().signal, model: { input: ['text'] }, providerOff: [],
    fetch: async (/** @type {string} */ url, /** @type {any} */ init) => answer(url, init),
    llm: { call: async () => { throw new Error('no model'); } },
  });
  return { ...k, trip, tool, run };
}
/** What a promise failed with, in words. @param {Promise<unknown>} p */
const failure = async (p) => {
  try {
    await p;
  } catch (e) {
    return String(/** @type {any} */ (e)?.message ?? e);
  }
  assert.fail('it should have failed');
};
const down = () => { throw new TypeError('Failed to fetch'); };

test("each built-in plugin's name and description are in the screens' words", async () => {
  const k = await kit();
  const manifests = [...k.host.builtins.values()];
  // Voice on this device and Sensors need a browser to start: their manifests are read as they load.
  for (const id of ['voice-browser', 'sensors']) manifests.push((await import(at(id))).manifest);
  assert.equal(manifests.length, 9);
  for (const m of manifests) {
    assert.match(m.name, JA, m.id);
    assert.match(m.description, JA, m.id);
  }
  assert.equal(k.host.builtins.get('files').name, 'ファイルツール');
});

test("Shiori's side stays English: every built-in tool's name, description and schema", async () => {
  const s = await startMcpServer();
  try {
    const k = await kit();
    await k.registry.list('mcp-servers')[0].add({ name: 'trail', url: s.url });
    const tools = k.registry.list('tool');
    assert.ok(tools.length >= 20, `${tools.length} tools`);
    for (const x of tools) assert.doesNotMatch(JSON.stringify({ name: x.name, group: x.group, description: x.description, input: x.input }), JA, x.name);
    assert.ok(tools.some((x) => x.group === 'MCP: trail' && /\(from the MCP server trail\)$/.test(x.description)));
  } finally {
    await s.stop();
  }
});

test("what the tools answer, and why they failed, stays English under Japanese screens", async () => {
  NOMINATIM_GAP.ms = 1;
  nominatimReset();
  const k = await kit();
  const said = [
    await failure(k.run('read', { path: '/trip/nowhere.md' }, down)),
    await failure(k.run('write', { path: '/me/personalities/x.md', content: 'x' }, down)),
    await failure(k.run('maps_link', { destination: 'Big Sur' }, down)),
    await failure(k.run('fetch', { url: 'not an address' }, down)),
    await failure(k.run('geocode', { query: 'Big Sur' }, () => Response.json({ not: 'a list' }))),
    await k.run('weather', { lat: 36.27, lng: -121.81, when: '2026-06-21' }, down),
    await k.run('search', { query: 'tide' }, down),
  ];
  assert.match(said[0], /^No file at \/trip\/nowhere\.md\./);
  assert.match(said[1], /^Personalities change only through tune_personality\./);
  assert.match(said[2], /^annai hasn't downloaded its link formats yet\./);
  assert.match(said[3], /isn't a web address/);
  assert.match(said[4], /^Nominatim sent an answer annai can't read\./);
  assert.match(said[5], /^Open-Meteo didn't answer .*sunrise/);
  assert.equal(said[6], 'Nothing matches "tide".');
  // web_search names the providers it passed over as Shiori is told them, though Settings → Tools shows them in Japanese.
  cooldowns.rest('wiki');
  try {
    const why = await failure(k.run('web_search', { query: 'tide pools' }, down));
    assert.match(why, /^Web search didn't work: .*Jina Search needs a key \(Settings → Tools\).*Wikivoyage, Wikipedia and Nominatim is resting after a failure/);
    for (const x of said.concat(why)) assert.doesNotMatch(x, JA, x);
  } finally {
    for (const id of ['exa', 'parallel', 'firecrawl', 'wiki']) cooldowns.clear(id);
  }
  const search = Object.fromEntries(k.registry.list('search').map((/** @type {any} */ p) => [p.id, p]));
  assert.equal(search.wiki.name, 'Wikivoyage、Wikipedia、Nominatim');
  assert.equal(search.wiki.en, 'Wikivoyage, Wikipedia and Nominatim');
  const jina = await search.jina.ready();
  assert.match(jina.why, JA);
  assert.equal(jina.en, 'needs a key (Settings → Tools)');
});

test("an MCP server: the screen's refusals in its words, Shiori's in English", async () => {
  const s = await startMcpServer({ token: 'mcp-token-0123456789' });
  const k = await kit();
  const servers = k.registry.list('mcp-servers')[0];
  try {
    assert.match(await failure(servers.add({ name: 'Trail!', url: s.url })), JA);
    assert.match(await failure(servers.add({ name: 'trail', url: s.url, token: 'wrong-token-00000' })), JA);
    await servers.add({ name: 'trail', url: s.url, token: 'mcp-token-0123456789' });
    const fail = await failure(k.run('mcp_trail_fail', {}, (url, init) => fetch(url, init)));
    assert.match(fail, /failed on purpose/);
    assert.doesNotMatch(fail, JA);
  } finally {
    await s.stop();
  }
  // The server is gone: Shiori hears why in English, the screen's Refresh says it in Japanese.
  const gone = await failure(k.tool('mcp_trail_echo').run({ text: 'tide' }, { trip: k.trip, scope: k.trip, signal: new AbortController().signal }));
  assert.match(gone, /^annai couldn't reach the MCP server trail\./);
  const refresh = await failure(servers.refresh('trail'));
  assert.match(refresh, JA);
  assert.match(refresh, /trail/);
});

test("a third party named as a built-in is shown as such in the screens' words: refused there, and after a change of language shown with its id", async () => {
  const k = await kit();
  const { codePlugin } = await import('./package-kit.js');
  // Under Japanese screens the web plugin is Web ツール, so a package called "Web tools" installs.
  await assert.rejects(k.host.install(codePlugin('webby', 'return () => {};', { name: 'Web ツール' })), /annai's own name/);
  await k.host.install(codePlugin('webby', 'return () => {};', { name: 'Web tools' }));
  // English screens: annai restarts, the built-in is Web tools again, and the package's row says whose it is.
  setWords('en', null);
  try {
    const host = k.relaunch();
    await host.addBuiltin(`${at('web')}?en`);
    const rows = await host.describe();
    assert.equal(rows.find((r) => r.id === 'web')?.name, 'Web tools');
    assert.equal(rows.find((r) => r.id === 'webby')?.name, 'Web tools (webby)');
    const { ownerName } = await import('../../src/ui/screens/plugin-install.js');
    assert.equal(ownerName(rows, 'webby'), 'Web tools (webby)');
  } finally {
    setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
  }
});
