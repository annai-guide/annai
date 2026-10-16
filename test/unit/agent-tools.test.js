import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Registry } from '../../src/core/registry.js';
import { tsv } from '../../src/core/tsv.js';
import { checkTool, toolList, definitions, runTool, Stuck, resolvePath, RESULT_MAX } from '../../src/core/agent/tools.js';
import { tracedFetch } from '../../src/core/agent/net.js';

const tool = (/** @type {string} */ name, /** @type {any} */ run = () => 'ok') => ({ name, description: `The ${name} tool.`, input: { type: 'object' }, run });
const call = (/** @type {AbortSignal} */ signal = new AbortController().signal) => /** @type {any} */ ({ scope: 'trip-1', trip: 'trip-1', signal, model: null, wake: 'w', author: 'shiori' });

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

test('runTool: text, objects as JSON, photos kept, errors as results, and huge results cut with a note', async () => {
  assert.deepEqual((await runTool(tool('a', () => 'fine'), {}, call())).output, { content: 'fine' });
  assert.deepEqual((await runTool(tool('a', () => ({ temp: 21 })), {}, call())).output, { content: '{"temp":21}' });
  const photo = { content: 'A photo', images: [{ mediaType: 'image/webp', hash: 'h' }] };
  assert.deepEqual((await runTool(tool('a', () => photo), {}, call())).output, photo);
  assert.deepEqual((await runTool(tool('a', () => { throw new Error('No such file: /trip/x.md'); }), {}, call())).output, { content: 'Error: No such file: /trip/x.md', isError: true });
  const big = (await runTool(tool('a', () => 'x'.repeat(RESULT_MAX + 10)), {}, call())).output.content;
  assert.equal(big.length < RESULT_MAX + 200, true);
  assert.match(big, /10 more characters were cut/);
});

test('runTool: a tool that hangs stops when the user stops Shiori, with a result', async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);
  const r = await runTool(tool('a', () => new Promise(() => {})), {}, call(stop.signal));
  assert.deepEqual(r.output, { content: 'Stopped by the user.', isError: true });
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
  assert.throws(() => resolvePath('/trip/notes/a.md', null), /No trip is open/);
  assert.throws(() => resolvePath('/etc/passwd', 'trip-1'), /start with \/trip\/ or \/me\//);
  assert.throws(() => resolvePath('/trip/.annai/meta.json', 'trip-1'), /reserved/);
});

test('tracedFetch: every request is in the trace, with credentials in the address blanked', async () => {
  const store = createMemoryStore();
  const get = tracedFetch(store, 'trip-1', { tool: 'fetch', wake: 'w-1' }, async () => new Response('hello', { status: 200 }));
  const res = await get('https://user:pw@api.example.com/search?q=big+sur&api_key=SECRET123');
  assert.equal(await res.text(), 'hello');
  const failing = tracedFetch(store, 'trip-1', { tool: 'fetch', wake: 'w-1' }, async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(failing('https://blocked.example.com/'), TypeError);
  const evs = await store.tx(['events'], 'readonly', (t) => t.listEvents('trip-1', { types: ['net.request'] }));
  assert.equal(evs[0].data.url, 'https://api.example.com/search?q=big+sur&api_key=%C2%ABkey%C2%BB');
  assert.equal(evs[0].data.status, 200);
  assert.equal(evs[0].data.tool, 'fetch');
  assert.equal(evs[1].data.error, 'Failed to fetch');
  assert.doesNotMatch(JSON.stringify(evs), /SECRET123|pw@/);
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
  await assert.rejects(failing('https://a.test/?k=WXSECRET9876'), TypeError);
  const evs = await store.tx(['events'], 'readonly', (t) => t.listEvents('sys', { types: ['net.request'] }));
  assert.equal(evs.length, 4);
  assert.doesNotMatch(JSON.stringify(evs), /WXSECRET9876|LLMSECRET42/);
  assert.match(evs[0].data.url, /q=big\+sur/);
});
