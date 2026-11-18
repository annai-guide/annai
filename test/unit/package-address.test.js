import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPackage, rawAddress } from '../../src/core/packages.js';
import { ZipWriter } from '../../src/core/zip.js';
import { utf8, text } from '../../src/core/bytes.js';
import { QUIET_MS, quietly } from '../../src/core/answer.js';
import { getEventListeners } from 'node:events';
import { download } from '../../src/core/llm/official.js';
import { sha256Hex } from '../../src/core/hash.js';
import { messageOf } from '../../src/ui/dom.js';
import { SKILL } from './package-kit.js';
import { dead, watch, turns, siteOn } from './dead-kit.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { SYS } from '../../src/core/scopes.js';

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

test("a file a SKILL.md links to is left out only when the site answers it hasn't it (404, 410, 403); a busy site or no answer fails, naming the file", async () => {
  const at = `${T}/tide-pools/references/safety.md`;
  for (const status of [404, 410, 403]) {
    assert.deepEqual(names(await fetchPackage(`${T}/tide-pools/SKILL.md`, web({ [`${T}/tide-pools/SKILL.md`]: SKILL, [at]: status }))), ['SKILL.md']);
  }
  for (const status of [503, 429, 500]) {
    await assert.rejects(fetchPackage(`${T}/tide-pools/SKILL.md`, web({ [`${T}/tide-pools/SKILL.md`]: SKILL, [at]: status })),
      new RegExp(`trails.example answered ${status} for references/safety.md, a file its SKILL.md names`));
  }
  await assert.rejects(fetchPackage(`${T}/tide-pools/SKILL.md`, web({ [`${T}/tide-pools/SKILL.md`]: SKILL, [at]: new TypeError('Failed to fetch') })),
    /annai couldn't read references\/safety.md from trails.example, a file its SKILL.md names/);
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

test('a zip address: what it unpacks to counts against the same limit as the download', async () => {
  const z = new ZipWriter();
  await z.add('a.txt', utf8('a'.repeat(5000)));
  await z.add('b.txt', utf8('b'.repeat(5000)));
  const { fetch } = web({ [`${T}/big.zip`]: new Uint8Array(await z.finish().arrayBuffer()) });
  await assert.rejects(fetchPackage(`${T}/big.zip`, { fetch, max: 8000 }), /too large/);
  assert.equal((await fetchPackage(`${T}/big.zip`, { fetch, max: 10_000 })).size, 2);
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
    await assert.rejects(fetchPackage(address, { fetch, ...(max ? { max } : {}) }), (e) => /** @type {any} */ (e).name === 'Error' && why.test(/** @type {Error} */ (e).message), address);
  }
});

test('8a-1: an address with a name or password before an @ is refused before anything is fetched', async () => {
  const w = web({});
  await assert.rejects(fetchPackage('https://me:pw@trails.example/kits/tide-pools/SKILL.md', { fetch: w.fetch }), /name or password before an @\. Leave it out\./);
  assert.deepEqual(w.asked, []);
});

test('8a-4: a manifest naming a file with a scheme is refused before anything else is fetched, so nothing is read off its site', async () => {
  for (const entry of ['http:/evil.example/x.js', 'https:evil.example/x.js']) {
    const w = web({ [`${T}/tides/annai-plugin.json`]: JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry, files: ['lib.js'] }), [`${T}/tides/lib.js`]: '' });
    await assert.rejects(fetchPackage(`${T}/tides/annai-plugin.json`, { fetch: w.fetch }), new RegExp(`The file name "${entry.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}" isn't allowed`));
    assert.deepEqual(w.asked, [`${T}/tides/annai-plugin.json`]);
  }
  // A skill's link with a scheme is left out, as before.
  const w = web({ [`${T}/s/SKILL.md`]: SKILL.replace('references/safety.md', 'http:/evil.example/x.md') });
  assert.deepEqual(names(await fetchPackage(`${T}/s/SKILL.md`, { fetch: w.fetch })), ['SKILL.md']);
  assert.ok(w.asked.every((u) => u.startsWith(T)));
});

test('8a-4 (follow-up): a name that would lead out of the package once it is an address is refused; lib/util.js still comes', async () => {
  for (const name of [' http:/evil.example/x.js', '\thttp:/evil.example/x.js', '\\\\evil.example\\x.js', '%2e%2e/%2e%2e/x.js']) {
    const w = web({ [`${T}/tides/annai-plugin.json`]: JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, files: [name] }) });
    await assert.rejects(fetchPackage(`${T}/tides/annai-plugin.json`, { fetch: w.fetch }), /isn't allowed/, JSON.stringify(name));
    assert.deepEqual(w.asked, [`${T}/tides/annai-plugin.json`], JSON.stringify(name));
  }
  const ok = web({ [`${T}/tides/annai-plugin.json`]: JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js', files: ['lib/util.js'] }), [`${T}/tides/index.js`]: '', [`${T}/tides/lib/util.js`]: '' });
  assert.deepEqual(names(await fetchPackage(`${T}/tides/annai-plugin.json`, { fetch: ok.fetch })).sort(), ['annai-plugin.json', 'index.js', 'lib/util.js']);
  // A SKILL.md's links: the same ones are left out, and nothing is asked outside its folder.
  const links = ['%2e%2e/%2e%2e/secret.md', '\\\\evil.example\\x.md', 'references/safety.md'].map((l, i) => `[${i}](${l})`).join(' ');
  const w = web({ [`${T}/s/SKILL.md`]: SKILL.replace('See [safety](references/safety.md).', links), [`${T}/s/references/safety.md`]: 'Watch the waves.' });
  assert.deepEqual(names(await fetchPackage(`${T}/s/SKILL.md`, { fetch: w.fetch })), ['SKILL.md', 'references/safety.md']);
  assert.ok(w.asked.every((u) => u.startsWith(`${T}/s/`)), w.asked.join(' '));
});

test("minors 17: every file of a package is asked for with the browser's cache revalidated, so an unchanged one comes back as a 304 from its cache, never a stale copy", async () => {
  const manifest = JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js', skills: ['skills/tide-pools'] });
  const routes = { [`${T}/tides/annai-plugin.json`]: manifest, [`${T}/tides/index.js`]: '', [`${T}/tides/skills/tide-pools/SKILL.md`]: SKILL, [`${T}/tides/skills/tide-pools/references/safety.md`]: 'Watch the waves.' };
  /** @type {(RequestInit | undefined)[]} */
  const inits = [];
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    inits.push(init);
    return new Response(routes[url]);
  };
  await fetchPackage(`${T}/tides/annai-plugin.json`, { fetch });
  assert.equal(inits.length, 4);
  assert.ok(inits.every((i) => i?.cache === 'no-cache'), JSON.stringify(inits));
  // No header of annai's own: one would make the browser ask the site first (CORS), which GitHub's raw files refuse.
  assert.ok(inits.every((i) => i?.headers === undefined));
});

test("minors 19: a GitHub folder's address, which web apps can't read, says to use the address of its SKILL.md or annai-plugin.json", async () => {
  const { fetch } = web({ 'https://github.com/o/r/tree/main/skills/tide-pools': new TypeError('Failed to fetch') });
  await assert.rejects(fetchPackage('https://github.com/o/r/tree/main/skills/tide-pools', { fetch }),
    /^Error: annai couldn't reach github\.com\. .* For a folder on GitHub, use the address of its SKILL\.md or annai-plugin\.json\.$/);
  const other = web({ [`${T}/x`]: new TypeError('Failed to fetch') });
  await assert.rejects(fetchPackage(`${T}/x`, { fetch: other.fetch }), (e) => !/GitHub/.test(/** @type {Error} */ (e).message));
});

test('minors 21: a file an annai-plugin.json names that the site lacks is named', async () => {
  const manifest = JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js', files: ['lib/util.js'] });
  const { fetch } = web({ [`${T}/tides/annai-plugin.json`]: manifest, [`${T}/tides/index.js`]: '' });
  await assert.rejects(fetchPackage(`${T}/tides/annai-plugin.json`, { fetch }), /^Error: trails\.example answered 404 for lib\/util\.js, a file its annai-plugin\.json names\.$/);
});

// addr-limit-next: an address whose site goes dead (takes the request, then sends nothing) held Add's Get it at "Getting it…" until the
// screen was left, and its request, an Update from it and the update checks that ask it, until annai was restarted. These run on fake
// timers against a site on this machine, through Node's own fetch (dead-kit.js).

/** The words for a site that stopped answering. @param {string} base */
const stopped = (base) => `${new URL(base).host} stopped answering. Check the connection and try again.`;

test("an address whose site goes dead ends after QUIET_MS of nothing, saying the site stopped answering and what to do: a site that never answers, one that sends its headers and nothing more, and one that stops part way, for the address's first file and for one it names", async (t) => {
  const MANIFEST = JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js', files: ['lib.js'] });
  /** @type {'never' | 'headers' | 'part'} */
  let how = 'never';
  let gone = '';
  const s = await siteOn((path, res) => {
    if (path !== gone) {
      res.writeHead(200).end(path.endsWith('/annai-plugin.json') ? MANIFEST : 'export {};');
      return;
    }
    if (how === 'never') return;
    res.writeHead(200);
    if (how === 'headers') res.flushHeaders();
    else res.write(' '.repeat(1024));
  });
  t.after(s.close);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [shape, which, path] of /** @type {const} */ ([
    ['never', 'first', '/tides/annai-plugin.json'], ['headers', 'first', '/tides/annai-plugin.json'], ['part', 'first', '/tides/annai-plugin.json'],
    ['never', 'named', '/tides/lib.js'], ['headers', 'named', '/tides/lib.js'], ['part', 'named', '/tides/lib.js'],
  ])) {
    how = shape;
    gone = path;
    s.asked.length = 0;
    s.seen = 0;
    s.answered = 0;
    const w = watch(fetchPackage(`${s.base}/tides/annai-plugin.json`, { fetch: s.fetch }));
    // Asked, and what comes before the silence come: the limit runs from the last thing that came.
    const answers = (which === 'named' ? 1 : 0) + (shape === 'never' ? 0 : 1);
    const seen = (which === 'named' ? MANIFEST.length : 0) + (shape === 'part' ? 1024 : 0);
    await turns(() => s.asked.includes(path) && s.answered === answers && s.seen >= seen);
    assert.ok(s.asked.includes(path) && s.answered === answers && s.seen >= seen, `${which} ${shape}: the request was made`);
    t.mock.timers.tick(QUIET_MS - 1);
    await turns(() => w.state !== 'pending', 50);
    assert.equal(w.state, 'pending', `${which} ${shape}: still waiting just short of the limit`);
    t.mock.timers.tick(1);
    await turns(() => w.state !== 'pending');
    assert.equal(w.state, 'failed', `${which} ${shape}: ended at the limit`);
    assert.equal(messageOf(w.error), stopped(s.base), `${which} ${shape}`);
    assert.equal(w.error?.said?.code, 'quiet', `${which} ${shape}: said as data`);
  }
});

test("an address whose answer and each part of its file come less than QUIET_MS apart installs, however long it takes in all: the limit is on silence, not on the whole request", async (t) => {
  /** @type {import('node:http').ServerResponse | undefined} */
  let reply;
  const s = await siteOn((path, res) => {
    if (path.endsWith('/SKILL.md')) reply = res;
    else res.writeHead(404).end();
  });
  t.after(s.close);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(fetchPackage(`${s.base}/kits/tide-pools/SKILL.md`, { fetch: s.fetch }));
  await turns(() => reply !== undefined);
  t.mock.timers.tick(QUIET_MS - 1);
  /** @type {import('node:http').ServerResponse} */ (reply).writeHead(200).flushHeaders();
  await turns(() => s.answered === 1);
  assert.equal(s.answered, 1, 'its answer came');
  let sent = 0;
  for (const part of [SKILL.slice(0, 40), SKILL.slice(40, 120), SKILL.slice(120)]) {
    t.mock.timers.tick(QUIET_MS - 1);
    /** @type {import('node:http').ServerResponse} */ (reply).write(part);
    sent += Buffer.byteLength(part);
    await turns(() => s.seen >= sent);
    assert.equal(w.state, 'pending', `after ${sent} bytes`);
  }
  t.mock.timers.tick(QUIET_MS - 1);
  /** @type {import('node:http').ServerResponse} */ (reply).end();
  await turns(() => w.state !== 'pending');
  assert.equal(w.state, 'done', 'five times QUIET_MS - 1 in all, never QUIET_MS with nothing');
  assert.equal(text(/** @type {Uint8Array} */ (w.value?.get('SKILL.md'))), SKILL);
});

test("the silence is the address's own site's: annai's site sending all the while never keeps a dead address's request open", async (t) => {
  const gone = await siteOn(() => {});
  /** @type {import('node:http').ServerResponse | undefined} */
  let file;
  const annai = await siteOn((_path, res) => {
    res.writeHead(200);
    res.flushHeaders();
    file = res;
  });
  t.after(gone.close);
  t.after(annai.close);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parts = ['aaaa', 'bbbb', 'cccc'];
  const entry = /** @type {any} */ ({ id: 'busy', name: 'Busy', version: '0.1.0', files: { 'big.js': await sha256Hex(utf8(parts.join(''))) } });
  const files = watch(download(entry, { fetch: annai.fetch, base: annai.base }));
  await turns(() => file !== undefined && annai.answered === 1);
  const address = watch(fetchPackage(`${gone.base}/kits/tide-pools/SKILL.md`, { fetch: gone.fetch }));
  await turns(() => gone.asked.length === 1);
  const write = async (/** @type {string} */ part, /** @type {number} */ seen) => {
    /** @type {import('node:http').ServerResponse} */ (file).write(part);
    await turns(() => annai.seen >= seen);
  };
  // annai's site sends a part just short of the address's limit: the address's silence goes on, and it ends at the limit.
  t.mock.timers.tick(QUIET_MS - 1);
  await write(parts[0], 4);
  t.mock.timers.tick(1);
  await turns(() => address.state !== 'pending');
  assert.equal(address.state, 'failed', "the dead address ended at QUIET_MS though annai's site kept sending");
  assert.equal(messageOf(address.error), stopped(gone.base));
  // annai's file goes on, each part QUIET_MS - 1 after the one before.
  t.mock.timers.tick(QUIET_MS - 2);
  await write(parts[1], 8);
  t.mock.timers.tick(QUIET_MS - 1);
  await write(parts[2], 12);
  /** @type {import('node:http').ServerResponse} */ (file).end();
  await turns(() => files.state !== 'pending');
  assert.equal(files.state, 'done', messageOf(files.error));
});

test("two packages asked of one site at once share its silence: one whose answer waits while the other's file keeps coming is not ended, as on one connection an answer waits behind bytes already sent for others (passes with no limit too: it pins the site's silence against a silence per request)", async (t) => {
  /** @type {import('node:http').ServerResponse | undefined} */
  let a;
  /** @type {import('node:http').ServerResponse | undefined} */
  let b;
  const s = await siteOn((path, res) => {
    if (path === '/a/SKILL.md') {
      res.writeHead(200);
      res.flushHeaders();
      a = res;
    } else if (path === '/b/SKILL.md') b = res;
    else res.writeHead(404).end();
  });
  t.after(s.close);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = watch(fetchPackage(`${s.base}/a/SKILL.md`, { fetch: s.fetch }));
  const second = watch(fetchPackage(`${s.base}/b/SKILL.md`, { fetch: s.fetch }));
  await turns(() => a !== undefined && b !== undefined && s.answered === 1);
  let sent = 0;
  for (const part of [SKILL.slice(0, 40), SKILL.slice(40, 120), SKILL.slice(120)]) {
    t.mock.timers.tick(QUIET_MS - 1);
    /** @type {import('node:http').ServerResponse} */ (a).write(part);
    sent += Buffer.byteLength(part);
    await turns(() => s.seen >= sent);
    await turns(() => second.state !== 'pending', 50);
    assert.equal(second.state, 'pending', `the held answer, after ${sent} bytes of the other`);
  }
  /** @type {import('node:http').ServerResponse} */ (a).end();
  await turns(() => first.state !== 'pending');
  assert.equal(first.state, 'done', messageOf(first.error));
  /** @type {import('node:http').ServerResponse} */ (b).writeHead(200).end(SKILL);
  await turns(() => second.state !== 'pending');
  assert.equal(second.state, 'done', messageOf(second.error));
});

test("through Get it's traced fetch, a site that never answers ends with the same words, and the trace says why in annai's English, though the trace's fetch and fetchPackage each wrap the error first (a stall after the headers is traced at the status the server gave: the trace writes a request at its answer)", async (t) => {
  const store = createMemoryStore();
  let asked = false;
  const get = tracedFetch(store, SYS, { tool: 'plugins' }, (_url, init) => {
    asked = true;
    return dead(init, 'never');
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(fetchPackage('https://gone.example/kits/tide-pools/SKILL.md', { fetch: get }));
  await turns(() => asked);
  t.mock.timers.tick(QUIET_MS);
  await turns(() => w.state !== 'pending');
  assert.equal(messageOf(w.error), 'gone.example stopped answering. Check the connection and try again.');
  const events = await store.tx(['events'], 'readonly', (/** @type {any} */ tx) => tx.listEvents(SYS, { types: ['net.request'] }));
  assert.deepEqual(events.map((/** @type {any} */ e) => [e.data.url, e.data.status, e.data.error]), [['https://gone.example/kits/tide-pools/SKILL.md', 0, 'gone.example stopped answering: nothing came for 20 seconds.']]);
});

// The limit is the request's own: it holds whatever the request and its read wait on, not only a fetch and a body that end when their
// signal aborts (the fix round after the final review of addr-limit-next).

test("a request whose fetch waits on something that never settles before it asks (Get it's traced fetch reading the keys it blanks) ends after QUIET_MS too, with the same words", async (t) => {
  const store = { ...createMemoryStore(), tx: () => new Promise(() => {}) };
  const get = tracedFetch(store, SYS, { tool: 'plugins' }, () => { throw new Error('asked'); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(fetchPackage('https://gone.example/kits/tide-pools/SKILL.md', { fetch: get }));
  await turns(() => false, 50);
  t.mock.timers.tick(QUIET_MS - 1);
  await turns(() => w.state !== 'pending', 50);
  assert.equal(w.state, 'pending', 'still waiting just short of the limit');
  t.mock.timers.tick(1);
  await turns(() => w.state !== 'pending');
  assert.equal(w.state, 'failed', 'ended at the limit');
  assert.equal(messageOf(w.error), 'gone.example stopped answering. Check the connection and try again.');
  assert.equal(w.error?.said?.code, 'quiet');
});

test("a request whose body doesn't end when the request is stopped (an engine that leaves the stream open) ends after QUIET_MS too, with the same words", async (t) => {
  const get = async () => new Response(new ReadableStream({ start: (c) => { c.enqueue(new Uint8Array(1024)); } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(fetchPackage('https://gone.example/kits/tide-pools/SKILL.md', { fetch: get }));
  await turns(() => false, 50);
  t.mock.timers.tick(QUIET_MS - 1);
  await turns(() => w.state !== 'pending', 50);
  assert.equal(w.state, 'pending', 'still waiting just short of the limit');
  t.mock.timers.tick(1);
  await turns(() => w.state !== 'pending');
  assert.equal(w.state, 'failed', 'ended at the limit');
  assert.equal(messageOf(w.error), 'gone.example stopped answering. Check the connection and try again.');
});

test("a request that ends, by its silence or on its own, leaves nothing behind: no listener on its signal, and no timer that a later part from its site could start (passes with no race too: it guards the race's own clean-up)", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** @type {Record<string, AbortSignal>} */
  const signals = {};
  /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
  let later;
  const get = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    signals[url] = /** @type {AbortSignal} */ (init.signal);
    if (url.endsWith('/own')) return new Response('done');
    // Ends with its request, as a browser's body does.
    return new Response(new ReadableStream({ start: (c) => { later = c; init.signal?.addEventListener('abort', () => c.error(init.signal?.reason), { once: true }); } }));
  };
  const own = await quietly(get, 'https://site.example/own', (res) => res.text());
  assert.equal(own, 'done');
  const silent = watch(quietly(get, 'https://site.example/silent', (res) => res.text()));
  await turns(() => later !== undefined);
  // A part of the silent one's body comes: it starts the clock of every request of the site still waiting, and the finished one is none.
  /** @type {ReadableStreamDefaultController<Uint8Array>} */ (later).enqueue(new Uint8Array(4));
  await turns(() => false, 50);
  t.mock.timers.tick(QUIET_MS - 1);
  await turns(() => false, 50);
  assert.equal(silent.state, 'pending');
  assert.equal(signals['https://site.example/own'].aborted, false, 'a finished request is never stopped later');
  t.mock.timers.tick(1);
  await turns(() => silent.state !== 'pending');
  assert.equal(silent.state, 'failed');
  assert.equal(signals['https://site.example/own'].aborted, false, 'a finished request is never stopped later');
  for (const [url, signal] of Object.entries(signals)) assert.equal(getEventListeners(signal, 'abort').length, 0, `${url}: no listener left on its signal`);
});
