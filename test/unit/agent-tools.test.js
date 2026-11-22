import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, keysUnread } from '../fakes/store-memory.js';
import { Registry } from '../../src/core/registry.js';
import { tsv } from '../../src/core/tsv.js';
import { checkTool, toolList, definitions, runTool, Stuck, resolvePath, RESULT_MAX } from '../../src/core/agent/tools.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { wellFormed } from '../../src/core/web-search.js';
import { readAppSettings } from '../../src/core/settings.js';
import { hostKit, codePlugin, builtinUrl } from './package-kit.js';

const tool = (/** @type {string} */ name, /** @type {any} */ run = () => 'ok') => ({ name, description: `The ${name} tool.`, input: { type: 'object' }, run });
const call = (/** @type {AbortSignal} */ signal = new AbortController().signal) => /** @type {any} */ ({ scope: 'trip-1', trip: 'trip-1', signal, model: null, wake: 'w', author: 'shiori' });
/** The keys a tool's error words are blanked of: none kept here. */
const store = createMemoryStore();

test('tsv: a header row, and tabs, newlines and "<" escaped the TSVZ way (spec §4.7)', () => {
  assert.equal(tsv(['name', 'note'], [['A\tB', 'x<y\nz\r'], [null, 3]]), 'name\tnote\nA<sep>B\tx<lt>y<LF>z<CR>\n\t3');
});

test("checkTool: names providers accept, a description, a schema object and run()", () => {
  assert.equal(checkTool(tool('nearby')), null);
  assert.match(String(checkTool(tool('watch.set'))), /name/);
  assert.match(String(checkTool(tool('x'.repeat(65)))), /name/);
  assert.match(String(checkTool({ ...tool('a'), description: '' })), /description/);
  assert.match(String(checkTool({ ...tool('a'), input: 'object' })), /input/);
  assert.match(String(checkTool({ ...tool('a'), run: null })), /run/);
});

test('toolList: the loop’s tools first, then plugins’ in order; a taken name is skipped; switches apply except to show, ask, wait and sleep', () => {
  const registry = new Registry();
  registry.add('files', 'tool', tool('read'));
  registry.add('other', 'tool', tool('read'));
  registry.add('web', 'tool', tool('fetch'));
  const loop = ['speak', 'show', 'ask', 'wait', 'sleep'].map((n) => ({ ...tool(n), pluginId: 'core' }));
  const list = toolList({ registry, switches: { fetch: false, speak: false, sleep: false }, loop });
  assert.deepEqual(list.map((t) => `${t.pluginId}:${t.name}`), ['core:show', 'core:ask', 'core:wait', 'core:sleep', 'files:read']);
  assert.deepEqual(definitions(list.slice(0, 1)), [{ name: 'show', description: 'The show tool.', input: { type: 'object' } }]);
});

test("a third-party tool with a built-in's name is not used, and the built-in answers; chosen, the plugin's answers; the loop's own tool names can't be taken", async () => {
  const { host, registry, ws } = await hostKit();
  await host.addBuiltin(builtinUrl('places', "return annai.tools.register({ name: 'weather', description: 'Built-in weather.', input: { type: 'object' }, run: () => 'sunny' });"));
  const loop = ['speak', 'recall'].map((n) => ({ ...tool(n), pluginId: 'core' }));
  host.connect({ agent: { loopTools: () => loop } });
  await host.install(codePlugin('clash-tool', "const offs = ['weather', 'recall', 'tell_kokoro', 'tides'].map((name) => annai.tools.register({ name, description: 'Mine.', input: { type: 'object' }, run: () => 'mine' })); return () => offs.forEach((f) => f());"));
  await host.start('clash-tool');
  const used = () => toolList({ registry, switches: {}, loop }).map((t) => `${t.pluginId}:${t.name}`);
  assert.deepEqual(used(), ['core:speak', 'core:recall', 'places:weather', 'clash-tool:tides']);
  assert.deepEqual(registry.clashes('clash-tool').map((c) => [c.name, c.owner, c.used, c.reserved]), [['weather', 'places', false, false], ['recall', 'annai', false, true], ['tell_kokoro', 'annai', false, true]]);
  await host.choose('tool', 'weather', 'clash-tool');
  assert.deepEqual(used(), ['core:speak', 'core:recall', 'clash-tool:weather', 'clash-tool:tides']);
  assert.deepEqual((await readAppSettings(ws)).uses, { 'tool:weather': 'clash-tool' });
  await assert.rejects(host.choose('tool', 'recall', 'clash-tool'), /recall is annai's own/);
  assert.deepEqual(used(), ['core:speak', 'core:recall', 'clash-tool:weather', 'clash-tool:tides']);
  // Undone: the built-in answers again, and nothing is kept.
  await host.choose('tool', 'weather', null);
  assert.deepEqual(used(), ['core:speak', 'core:recall', 'places:weather', 'clash-tool:tides']);
  assert.deepEqual((await readAppSettings(ws)).uses, {});
});

test('runTool: text, objects as JSON, photos kept, errors as results, and huge results cut with a note', async () => {
  assert.deepEqual((await runTool(tool('a', () => 'fine'), {}, call(), store)).output, { content: 'fine' });
  assert.deepEqual((await runTool(tool('a', () => ({ temp: 21 })), {}, call(), store)).output, { content: '{"temp":21}' });
  const photo = { content: 'A photo', images: [{ mediaType: 'image/webp', hash: 'h' }] };
  assert.deepEqual((await runTool(tool('a', () => photo), {}, call(), store)).output, photo);
  assert.deepEqual((await runTool(tool('a', () => { throw new Error('No such file: /trip/x.md'); }), {}, call(), store)).output, { content: 'Error: No such file: /trip/x.md', isError: true });
  const big = (await runTool(tool('a', () => 'x'.repeat(RESULT_MAX + 10)), {}, call(), store)).output.content;
  assert.equal(big.length < RESULT_MAX + 200, true);
  assert.match(big, /10 more characters were cut/);
});

test("runTool: the cut of a huge result never splits an emoji, and counts what it took (review of backlog 6)", async () => {
  const text = `${'x'.repeat(RESULT_MAX - 1)}😀${'y'.repeat(10)}`;
  const out = (await runTool(tool('a', () => text), {}, call(), store)).output.content;
  assert.ok(wellFormed(out) === out, 'no half of the emoji is left at the cut');
  const on = /\n… (\d+) more characters were cut\.$/.exec(out);
  assert.ok(on);
  assert.equal(out.slice(0, on.index), 'x'.repeat(RESULT_MAX - 1), 'the pair is left out whole');
  assert.equal(on.index + Number(on[1]), text.length, 'the count is what was left out');
});

test('runTool: a tool that hangs stops when the user stops Shiori, with a result', async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);
  const r = await runTool(tool('a', () => new Promise(() => {})), {}, call(stop.signal), store);
  assert.deepEqual(r.output, { content: 'Stopped by the user.', isError: true });
});

test("runTool: a third-party plugin's error repeating its key (a 403 for its address) holds «key», as the key is and URL-encoded, through annai's wrapper (a bug in its code) and as its tool threw it, and a tool run directly; when the keys can't be read, the note (tool-errors-next)", async () => {
  const { host, registry, store: kept } = await hostKit();
  const KEY = 'Tr4il key/9876+x'; // made up; URL-encoding changes its space, slash and plus
  await kept.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:trails:key', KEY));
  const said = `403 Forbidden for https://api.trails.example/v1/forecast?key=${encodeURIComponent(KEY)}&raw=${KEY}`;
  // A TypeError is a bug in its code, which annai's wrapper words as "The tool … failed: …"; an Error is its own answer, passed on as it is.
  await host.install(codePlugin('trails', `const said = ${JSON.stringify(said)};
    annai.tools.register({ name: 'trail_bug', description: 'Trails.', input: { type: 'object' }, run: () => { throw new TypeError(said); } });
    annai.tools.register({ name: 'trail_own', description: 'Trails.', input: { type: 'object' }, run: () => { throw new Error(said); } });`));
  await host.start('trails');
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  const direct = tool('trail_direct', () => { throw new Error(said); });
  const run = async (/** @type {any} */ t) => (await runTool(t, {}, call(), kept)).output;
  const blanked = '403 Forbidden for https://api.trails.example/v1/forecast?key=«key»&raw=«key»';
  assert.deepEqual(await run(tools.trail_bug), { content: `Error: trails: The tool trail_bug failed: ${blanked}`, isError: true });
  assert.deepEqual(await run(tools.trail_own), { content: `Error: ${blanked}`, isError: true });
  assert.deepEqual(await run(direct), { content: `Error: ${blanked}`, isError: true });
  const back = keysUnread(kept);
  try {
    for (const t of [tools.trail_bug, tools.trail_own, direct]) assert.deepEqual(await run(t), { content: "Error: annai couldn't check this message for keys, so it is not shown.", isError: true }, t.name);
  } finally {
    back();
  }
});

test('Stuck: three identical calls in a row with identical results (spec §6.6)', () => {
  const s = new Stuck();
  assert.equal(s.see('fetch', { url: 'a' }, 'same'), false);
  assert.equal(s.see('fetch', { url: 'a' }, 'same'), false);
  assert.equal(s.see('fetch', { url: 'a' }, 'same'), true);
  const t = new Stuck();
  t.see('fetch', { url: 'a' }, 'same');
  t.see('fetch', { url: 'a' }, 'other');
  assert.equal(t.see('fetch', { url: 'a' }, 'same'), false);
});

test('resolvePath: /trip/… and /me/… only; .annai is reserved', () => {
  assert.deepEqual(resolvePath('/trip/notes/a.md', 'trip-1'), { scope: 'trip-1', path: '/notes/a.md' });
  assert.deepEqual(resolvePath('/me/memory.md', null), { scope: 'me', path: '/memory.md' });
  assert.deepEqual(resolvePath('/trip/', 'trip-1'), { scope: 'trip-1', path: '/' });
  assert.deepEqual(resolvePath('/trip/notes/', 'trip-1'), { scope: 'trip-1', path: '/notes/' });
  assert.deepEqual(resolvePath('/me', null), { scope: 'me', path: '/' });
  assert.throws(() => resolvePath('/trip/notes/a.md', null), /Nothing is open/);
  assert.throws(() => resolvePath('/etc/passwd', 'trip-1'), /start with \/trip\/ or \/me\//);
  // The waiting space's root went with the no-trip conversation (timeline stage 7).
  for (const trip of [null, 'trip-1']) assert.throws(() => resolvePath('/waiting/files/a.pdf', trip), /start with \/trip\/ or \/me\//);
  assert.throws(() => resolvePath('/trip/.annai/meta.json', 'trip-1'), /reserved/);
});

test('tracedFetch: every request is in the trace, with credentials in the address blanked', async () => {
  const store = createMemoryStore();
  const get = tracedFetch(store, 'trip-1', { tool: 'fetch', wake: 'w-1' }, async () => new Response('hello', { status: 200 }));
  const res = await get('https://user:pw@api.example.com/search?q=big+sur&api_key=SECRET123');
  assert.equal(await res.text(), 'hello');
  const failing = tracedFetch(store, 'trip-1', { tool: 'fetch', wake: 'w-1' }, async () => { throw new TypeError('Failed to fetch'); });
  // A network failure reaches the tool as a plain error naming the host, so no plugin is switched off for it (spec §17).
  await assert.rejects(failing('https://blocked.example.com/'), (/** @type {any} */ e) => !(e instanceof TypeError) && /blocked\.example\.com/.test(e.message) && /offline/i.test(e.message));
  const evs = await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1', { types: ['net.request'] }));
  assert.equal(evs[0].data.url, 'https://api.example.com/search?q=big+sur&api_key=%C2%ABkey%C2%BB');
  assert.equal(evs[0].data.status, 200);
  assert.equal(evs[0].data.tool, 'fetch');
  assert.equal(evs[1].data.error, 'Failed to fetch');
  assert.doesNotMatch(JSON.stringify(evs), /SECRET123|pw@/);
});

test("tracedFetch: a request called off with a reason says that reason in the trace, whatever the browser's words; a stop with none keeps them", async () => {
  const store = createMemoryStore();
  // As WebKit does: the same words for any abort, whatever the signal's reason.
  const webkit = tracedFetch(store, 'trip-1', { tool: 'nearby' }, (_url, init) => new Promise((_, reject) => {
    const no = () => reject(new DOMException('Fetch is aborted', 'AbortError'));
    if (init?.signal?.aborted) no();
    else init?.signal?.addEventListener('abort', no, { once: true });
  }));
  /** @param {AbortSignal} signal @param {() => void} [stop] */
  const off = async (signal, stop) => {
    const asked = webkit('https://a.test/', { signal });
    stop?.();
    await assert.rejects(asked, { name: 'AbortError' });
  };
  const raced = new AbortController();
  await off(raced.signal, () => raced.abort(Object.assign(new Error('Stopped: the other Overpass server answered first.'), { name: 'AbortError' })));
  const late = AbortSignal.timeout(5);
  await off(late);
  const user = new AbortController();
  await off(user.signal, () => user.abort());
  const evs = await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1', { types: ['net.request'] }));
  assert.deepEqual(evs.map((e) => [e.data.status, e.data.error]), [
    [0, 'Stopped: the other Overpass server answered first.'],
    [0, late.reason.message],
    [0, 'Fetch is aborted'],
  ]);
});

test('tracedFetch: no secret annai keeps reaches the trace, whatever its parameter is called or wherever it sits', async () => {
  const store = createMemoryStore();
  await store.tx(['secrets'], 'readwrite', async (t) => {
    await t.putSecret('plugin:weather:key', 'WXSECRET9876');
    await t.putSecret('llm:ep-1', 'sk-ant-LLMSECRET42');
  });
  const ok = tracedFetch(store, 'sys', { tool: 'plugin:weather' }, async () => new Response('ok'));
  await ok('https://api.weather.test/v1/WXSECRET9876/forecast?appid=WXSECRET9876&q=big+sur');
  await ok('https://x.test/?note=sk-ant-LLMSECRET42');
  await ok('not an address ?appid=WXSECRET9876');
  const failing = tracedFetch(store, 'sys', { tool: 'plugin:weather' }, async () => { throw new TypeError('Failed to fetch https://a.test/?k=WXSECRET9876'); });
  // The error the tool sees (and Shiori reads) holds no secret either.
  await assert.rejects(failing('https://a.test/?k=WXSECRET9876'), (/** @type {any} */ e) => /a\.test/.test(e.message) && !/WXSECRET9876/.test(e.message));
  const evs = await store.tx(['events'], 'readonly', (t) => t.listEvents('sys', { types: ['net.request'] }));
  assert.equal(evs.length, 4);
  assert.doesNotMatch(JSON.stringify(evs), /WXSECRET9876|LLMSECRET42/);
  assert.match(evs[0].data.url, /q=big\+sur/);
});

test("tracedFetch: when the keys annai keeps can't be read, a request's record keeps its scheme and no host, path or error words, and the tool's error names no host and has no browser words", async () => {
  const store = createMemoryStore();
  await store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:weather:key', 'WXSECRET9876'));
  await store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:host:key', 'HOSTKEY7654321'));
  const back = keysUnread(store);
  const ok = tracedFetch(store, 'sys', { tool: 'plugin:weather' }, async () => new Response('ok'));
  await ok('https://api.weather.test/v1/WXSECRET9876/forecast?q=big+sur');
  const failing = tracedFetch(store, 'sys', { tool: 'plugin:weather' }, async () => { throw new TypeError('Failed to fetch https://api.weather.test/?k=WXSECRET9876'); });
  const e = await failing('https://api.weather.test/?k=WXSECRET9876').catch((/** @type {any} */ x) => x);
  assert.equal(e.message, "annai couldn't reach the address. Is the device offline?");
  assert.deepEqual(e.said, { code: 'unreachable', where: 'the address' });
  assert.equal(e.cause, undefined, 'no browser words');
  // A stored key can be the host's own name (a provider's per-account address): neither the trace nor the tool's error, which Shiori reads, may show it.
  const named = await tracedFetch(store, 'sys', { tool: 'plugin:weather' }, async () => { throw new TypeError('Failed to fetch'); })('https://HOSTKEY7654321.weather.test/forecast').catch((/** @type {any} */ x) => x);
  assert.equal(named.message, "annai couldn't reach the address. Is the device offline?");
  assert.doesNotMatch(JSON.stringify([named.message, named.said, named.shown]), /hostkey|weather\.test/i);
  // A key handed over to blank (in an address being tried) is still blanked, in the host too.
  await tracedFetch(store, 'sys', { tool: 'plugins', blank: ['TRIEDKEY55'] }, async () => new Response('ok'))('https://TRIEDKEY55.example.test/x');
  back();
  const evs = await store.tx(['events'], 'readonly', (t) => t.listEvents('sys', { types: ['net.request'] }));
  assert.deepEqual(evs.map((x) => [x.data.url, x.data.error]), [
    ['https://«key»/«key»', undefined],
    ['https://«key»/«key»', "The request failed. (annai couldn't check its error message for keys, so it is not kept.)"],
    ['https://«key»/«key»', "The request failed. (annai couldn't check its error message for keys, so it is not kept.)"],
    ['https://«key»/«key»', undefined],
  ]);
  assert.doesNotMatch(JSON.stringify(evs), /HOSTKEY7654321|weather\.test/i);
});

test("tracedFetch: with the keys readable, a host that is a stored key is named as the address in the tool's error, not as its blank read back", async () => {
  const store = createMemoryStore();
  await store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:host:key', 'HOSTKEY7654321'));
  const e = await tracedFetch(store, 'sys', { tool: 'plugin:weather' }, async () => { throw new TypeError('Failed to fetch'); })('https://HOSTKEY7654321.weather.test/forecast').catch((/** @type {any} */ x) => x);
  assert.equal(e.said.where, 'the address');
  assert.doesNotMatch(JSON.stringify([e.message, e.said, e.shown]), /hostkey|xn--/i);
});

test("tracedFetch: with the keys unread, an address that is no address keeps nothing of itself either", async () => {
  const store = createMemoryStore();
  await store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:weather:key', 'WXSECRET9876'));
  const back = keysUnread(store);
  await tracedFetch(store, 'sys', { tool: 'plugin:weather' }, async () => new Response('ok'))('not an address ?appid=WXSECRET9876');
  back();
  const evs = await store.tx(['events'], 'readonly', (t) => t.listEvents('sys', { types: ['net.request'] }));
  assert.deepEqual(evs.map((x) => x.data.url), ['«key»']);
});

test('tracedFetch: a secret is blanked however the address encodes it (encoding differences)', async () => {
  const store = createMemoryStore();
  const key = 'Ab+c/d e=fGh~Xy9';
  await store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:x:key', key));
  await store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:y:key', 'SubDomainKey77'));
  const ok = tracedFetch(store, 'sys', { tool: 'plugin:x' }, async () => new Response('ok'));
  const q = new URLSearchParams({ x: key }).toString().slice(2); // form encoding: the space as "+"
  await ok(`https://a.test/?x=${q}&q=fine`);
  await ok(`https://a.test/p/${encodeURIComponent(key).replace(/%2B/g, '%2b')}/end`); // lower-case hex
  await ok(`https://a.test/p/${key.replace(/ /g, '%20')}`); // left to the parser to encode
  await ok('https://SubDomainKey77.api.test/v1');
  await ok(`https://a.test/#${encodeURIComponent(key)}`);
  const evs = await store.tx(['events'], 'readonly', (t) => t.listEvents('sys', { types: ['net.request'] }));
  const all = JSON.stringify(evs.map((e) => e.data.url));
  for (const form of [key, encodeURIComponent(key), q, 'subdomainkey77', 'SubDomainKey77', 'Ab%2bc', 'Ab+c/d', 'c%2Fd']) {
    assert.equal(all.toLowerCase().includes(form.toLowerCase()), false, `${form} in ${all}`);
  }
  assert.match(evs[0].data.url, /q=fine/);
});

test('tracedFetch: fails closed when any decoding of the traced address could still show a secret (parser differences)', async () => {
  const store = createMemoryStore();
  const key = 'a b|c/d-SECRET`x';
  await store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:x:key', key));
  await store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:y:key', 'BACKSLASH99'));
  const ok = tracedFetch(store, 'sys', { tool: 'plugin:x' }, async () => new Response('ok'));
  await ok(`https://a.test/p/${key}/end?q=1`);
  await ok('https://a.test\\p\\BACKSLASH99\\x');
  const failing = tracedFetch(store, 'sys', { tool: 'plugin:x' }, async () => { throw new TypeError(`Failed: a%20b|c/d-SECRET%60x`); });
  await assert.rejects(failing('https://a.test/'), (/** @type {any} */ e) => e.message === "annai couldn't reach a.test. Is the device offline?");
  const evs = await store.tx(['events'], 'readonly', (t) => t.listEvents('sys', { types: ['net.request'] }));
  const squash = (/** @type {string} */ s) => s.toLowerCase().replace(/[\s/\\]+/g, '');
  for (const e of evs) {
    const seen = [e.data.url, e.data.error ?? ''].flatMap((t) => { const v = [t]; try { v.push(decodeURIComponent(t), decodeURIComponent(t.replace(/\+/g, ' '))); } catch { /* as is */ } return v; });
    for (const s of [key, 'BACKSLASH99']) assert.equal(seen.some((t) => squash(t).includes(squash(s))), false, `${s} in ${JSON.stringify(e.data)}`);
  }
  assert.match(evs[0].data.url, /^https:\/\/a\.test\//);
});
