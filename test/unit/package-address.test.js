import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPackage, rawAddress } from '../../src/core/packages.js';
import { ZipWriter } from '../../src/core/zip.js';
import { utf8 } from '../../src/core/bytes.js';
import { SKILL } from './package-kit.js';

/** A web of addresses: a string or bytes is a 200 answer, an Error is thrown as fetch would, a number is a status. */
function web(/** @type {Record<string, any>} */ routes) {
  /** @type {string[]} */
  const asked = [];
  const fetch = async (/** @type {string} */ url) => {
    asked.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return new Response('', { status: r });
    if (r === undefined) return new Response('not found', { status: 404 });
    return new Response(r);
  };
  return { fetch, asked };
}
const names = (/** @type {Map<string, Uint8Array>} */ m) => [...m.keys()];
const T = 'https://trails.example/kits';

test('a SKILL.md address: the skill, and the files it links to inside its folder', async () => {
  const { fetch, asked } = web({ [`${T}/tide-pools/SKILL.md`]: SKILL, [`${T}/tide-pools/references/safety.md`]: 'Watch the waves.' });
  assert.deepEqual(names(await fetchPackage(`${T}/tide-pools/SKILL.md`, { fetch })), ['SKILL.md', 'references/safety.md']);
  assert.equal(asked.length, 2);
});

test('a file a SKILL.md links to that is missing is left out (choice 6)', async () => {
  const { fetch } = web({ [`${T}/tide-pools/SKILL.md`]: SKILL });
  assert.deepEqual(names(await fetchPackage(`${T}/tide-pools/SKILL.md`, { fetch })), ['SKILL.md']);
});

test('an annai-plugin.json address: the manifest and every file it names', async () => {
  const manifest = JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js', files: ['index.js', 'lib.js'], skills: ['skills/tide-pools'] });
  const { fetch } = web({
    [`${T}/tides/annai-plugin.json`]: manifest, [`${T}/tides/index.js`]: 'import "./lib.js";', [`${T}/tides/lib.js`]: '',
    [`${T}/tides/skills/tide-pools/SKILL.md`]: SKILL, [`${T}/tides/skills/tide-pools/references/safety.md`]: 'Watch the waves.',
  });
  assert.deepEqual(names(await fetchPackage(`${T}/tides/annai-plugin.json`, { fetch })).sort(),
    ['annai-plugin.json', 'index.js', 'lib.js', 'skills/tide-pools/SKILL.md', 'skills/tide-pools/references/safety.md']);
});

test('a zip address: its files, whatever the address ends with', async () => {
  const z = new ZipWriter();
  await z.add('tide-pools/SKILL.md', utf8(SKILL));
  const { fetch } = web({ [`${T}/download?id=7`]: new Uint8Array(await z.finish().arrayBuffer()) });
  assert.deepEqual(names(await fetchPackage(`${T}/download?id=7`, { fetch })), ['tide-pools/SKILL.md']);
});

test("a GitHub page's address is read from GitHub's raw files", () => {
  assert.equal(rawAddress('https://github.com/o/r/blob/main/skills/x/SKILL.md'), 'https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md');
  assert.equal(rawAddress('https://github.com/o/r/raw/v1/annai-plugin.json'), 'https://raw.githubusercontent.com/o/r/v1/annai-plugin.json');
  assert.equal(rawAddress('https://trails.example/SKILL.md'), 'https://trails.example/SKILL.md');
});

test('addresses that hold no package, or fail, say what to do; nothing half-read is returned', async () => {
  const many = JSON.stringify({ id: 'many', name: 'Many', version: '1.0.0', api: 1, files: Array.from({ length: 201 }, (_, i) => `f${i}.js`) });
  const { fetch } = web({
    [`${T}/page`]: '<!DOCTYPE html><html>a folder page</html>',
    [`${T}/gone/SKILL.md`]: 404,
    [`${T}/closed/SKILL.md`]: new TypeError('Failed to fetch'),
    [`${T}/big/SKILL.md`]: SKILL,
    [`${T}/up/annai-plugin.json`]: JSON.stringify({ id: 'up', name: 'Up', version: '1.0.0', api: 1, entry: '../x.js' }),
    [`${T}/many/annai-plugin.json`]: many,
  });
  /** @type {[string, RegExp, number?][]} */
  const cases = [
    ['ftp://trails.example/x', /isn't a web address/],
    ['not an address', /isn't a web address/],
    [`${T}/page`, /no annai plugin or skill at that address/],
    [`${T}/gone/SKILL.md`, /answered 404/],
    [`${T}/closed/SKILL.md`, /couldn't reach trails\.example/],
    [`${T}/big/SKILL.md`, /more than annai reads/, 10],
    [`${T}/up/annai-plugin.json`, /"\.\.\/x\.js" isn't allowed/],
    [`${T}/many/annai-plugin.json`, /more than 200 files/],
  ];
  for (const [address, why, max] of cases) {
    await assert.rejects(fetchPackage(address, { fetch, ...(max ? { max } : {}) }), (e) => /** @type {any} */ (e).constructor === Error && why.test(/** @type {Error} */ (e).message), address);
  }
});
