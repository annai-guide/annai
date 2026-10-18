import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { utf8 } from '../../src/core/bytes.js';
import { logEvent } from '../../src/core/events.js';
import { SYS, SYS_SETTINGS, SYS_PLUGINS } from '../../src/core/scopes.js';
import { start, activate, serverProblem, shellBuild, BATCH_MS, BATCH_MAX, KEEP_MAX, BATCH_BYTES, ENTRY_BYTES, RETRY_MS, RETRY_MAX_MS, REFUSALS, SETTINGS_FILE } from '../../plugins-official/remote-trace/index.js';
import { hostKit } from './package-kit.js';

const root = new URL('../../', import.meta.url);
const T0 = 1_800_000_000_000;
const TOKEN = 'rt-token-0123456789abcdef';
const SERVER = 'https://sink.example/trace';

/** Lets every pending promise and I/O turn run. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

/** A clock the test moves on by hand; timers run only then, in time order. */
function virtualClock(t0 = T0) {
  let t = t0;
  let id = 0;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const due = new Map();
  return {
    now: () => t,
    timers: {
      set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
        due.set(++id, { at: t + Math.max(0, ms), fn });
        return id;
      },
      clear: (/** @type {any} */ h) => { due.delete(h); },
    },
    /** Moves on ms, running each timer that comes due on the way, and what it starts. @param {number} ms */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        const next = [...due].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        due.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
      await settle();
    },
  };
}

/** @param {number} seq @param {string} [type] @param {any} [data] */
const entry = (seq, type = 'msg.user', data = { text: `hello ${seq}` }) => Object.freeze({ scope: 'trip:1', seq, ts: T0 + seq, type, actor: 'user', data });

/**
 * The plugin, started on a stand-in of the annai object: its settings and token, a server that answers
 * as told, and what it drew and said. answer(n): the nth post's answer (a Response, or an Error to throw).
 * @param {{ settings?: any, token?: string | null, answer?: (n: number, init: any) => Response | Error | Promise<Response>, secrets?: Record<string, string> }} [o]
 */
async function kit({ settings = { server: SERVER, send: true }, token = TOKEN, answer = () => new Response('{}'), secrets = {} } = {}) {
  const clock = virtualClock();
  const store = createMemoryStore();
  await store.tx(['secrets'], 'readwrite', async (t) => {
    if (token) await t.putSecret('plugin:remote-trace:token', token);
    for (const [k, v] of Object.entries(secrets)) await t.putSecret(k, v);
  });
  /** @type {any} */
  const saved = { ...settings };
  /** @type {((e: any) => void) | null} */
  let hook = null;
  /** @type {{ url: string, init: any, body: any, at: number }[]} */
  const posts = [];
  /** @type {any[]} */
  const cards = [];
  /** @type {Map<string, any>} */
  const chips = new Map();
  /** @type {string[]} */
  const went = [];
  const annai = {
    id: 'remote-trace',
    files: { store },
    hooks: { on: (/** @type {any} */ fn) => { hook = fn; return () => { hook = null; }; } },
    settings: {
      get: async () => ({ location: false, send: false, ...saved }),
      set: async (/** @type {any} */ c) => { Object.assign(saved, c); },
    },
    secrets: { get: async (/** @type {string} */ n) => (await store.tx(['secrets'], 'readonly', (t) => t.getSecret(`plugin:remote-trace:${n}`))) ?? null },
    net: {
      fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
        posts.push({ url, init, body: JSON.parse(init.body), at: clock.now() });
        const a = await answer(posts.length, init);
        if (a instanceof Error) throw a;
        return a;
      },
    },
    ui: {
      slot: (/** @type {string} */ slot, /** @type {any} */ item) => {
        assert.equal(slot, 'status-chip');
        chips.set(item.id, item);
        return () => chips.delete(item.id);
      },
      card: (/** @type {any} */ c) => cards.push(c),
    },
  };
  const stop = start(annai, { timers: clock.timers, now: clock.now, cacheNames: async () => ['annai-inbox', 'annai-shell-0.1.0-96fe727820fb'] });
  await settle();
  return {
    clock, store, saved, posts, cards, chips, went, stop,
    /** Hands the plugin's hook log entries, as annai would. @param {any[]} es */
    give: (...es) => { for (const e of es) hook?.(e); },
    hooked: () => hook !== null,
    /** The user saves the plugin's form: its settings file changes, and the hook sees that. @param {any} changes */
    save: async (changes) => {
      Object.assign(saved, changes);
      hook?.(Object.freeze({ scope: SYS_SETTINGS, seq: 99, ts: clock.now(), type: 'file.write', actor: 'user', data: { path: SETTINGS_FILE, old: 'a', new: 'b' } }));
      await settle();
    },
    /** The chip as the dock draws it: its element, and where a tap goes. */
    drawChip: () => {
      const item = [...chips.values()][0];
      const attrs = new Map();
      /** @type {Map<string, (e: any) => void>} */
      const on = new Map();
      const el = {
        textContent: '', title: '', tabIndex: -1,
        setAttribute: (/** @type {string} */ k, /** @type {string} */ v) => attrs.set(k, v),
        getAttribute: (/** @type {string} */ k) => attrs.get(k) ?? null,
        addEventListener: (/** @type {string} */ k, /** @type {any} */ fn) => on.set(k, fn),
        removeEventListener: (/** @type {string} */ k) => on.delete(k),
      };
      const cleanup = item.render(el, { go: (/** @type {string} */ h) => went.push(h) });
      return { el, attrs, on, cleanup };
    },
  };
}

test('a batch goes 3 s after the first entry waiting, with what annai is, its build and a device id it keeps; signed with the token', async () => {
  const k = await kit();
  k.give(entry(1), entry(2), entry(3));
  await k.clock.advance(BATCH_MS - 1);
  assert.equal(k.posts.length, 0, 'not before 3 s');
  await k.clock.advance(1);
  assert.equal(k.posts.length, 1);
  const [p] = k.posts;
  assert.equal(p.url, SERVER);
  assert.equal(p.init.method, 'POST');
  assert.equal(new Headers(p.init.headers).get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(new Headers(p.init.headers).get('content-type'), 'application/json');
  assert.deepEqual(Object.keys(p.body), ['app', 'build', 'device', 'dropped', 'entries']);
  assert.equal(p.body.app, 'annai 0.1.0');
  assert.equal(p.body.build, '96fe727820fb');
  assert.match(p.body.device, /^[0-9a-f]{16}$/);
  assert.equal(k.saved.device, p.body.device, 'kept in its settings');
  assert.equal(p.body.dropped, 0);
  assert.deepEqual(p.body.entries, [entry(1), entry(2), entry(3)].map((e) => ({ ...e })));
  // The next batch: 3 s after its own first entry, from the same device.
  await k.clock.advance(10_000);
  k.give(entry(4));
  await k.clock.advance(BATCH_MS);
  assert.equal(k.posts.length, 2);
  assert.equal(k.posts[1].at - k.posts[0].at, 10_000 + BATCH_MS);
  assert.equal(k.posts[1].body.device, p.body.device);
  assert.deepEqual(k.posts[1].body.entries.map((/** @type {any} */ e) => e.seq), [4]);
  await k.clock.advance(60_000);
  assert.equal(k.posts.length, 2, 'nothing more to send, nothing sent');
  k.stop();
});

test('100 entries waiting go at once, one request at a time, at most 100 and 512 KiB in each', async () => {
  const k = await kit();
  k.give(...Array.from({ length: 250 }, (_, i) => entry(i + 1)));
  await k.clock.advance(0);
  assert.deepEqual(k.posts.map((p) => p.body.entries.length), [BATCH_MAX, BATCH_MAX], 'two full batches at once, one after the other');
  assert.deepEqual(k.posts[1].body.entries.map((/** @type {any} */ e) => e.seq).slice(0, 2), [101, 102]);
  await k.clock.advance(BATCH_MS);
  assert.deepEqual(k.posts.map((p) => p.body.entries.length), [100, 100, 50]);
  // Big entries: a batch stops before 512 KiB of JSON, and an entry over 64 KiB is sent cut, with what it was.
  const big = (/** @type {number} */ seq) => entry(seq, 'tool.call', { name: 'write', input: { text: 'é'.repeat(20 * 1024) } });
  k.give(...Array.from({ length: 30 }, (_, i) => big(1000 + i)), entry(2000, 'tool.result', { content: 'x'.repeat(ENTRY_BYTES + 10) }));
  await k.clock.advance(BATCH_MS);
  const sent = k.posts.slice(3);
  assert.ok(sent.length >= 2);
  for (const p of sent) assert.ok(JSON.stringify(p.body).length <= BATCH_BYTES + 1024, `a batch of ${JSON.stringify(p.body).length} bytes`);
  const all = sent.flatMap((p) => p.body.entries);
  assert.deepEqual(all.map((/** @type {any} */ e) => e.seq), [...Array.from({ length: 30 }, (_, i) => 1000 + i), 2000]);
  const cut = all.at(-1);
  assert.deepEqual(Object.keys(cut), ['scope', 'seq', 'ts', 'type', 'actor', 'data']);
  assert.match(cut.data.cut, /^\d+ bytes, more than the 65536 one entry may send$/);
  k.stop();
});

test('offline, it keeps the newest 2,000 entries and says how many it dropped, then sends them in order', async () => {
  let offline = true;
  const k = await kit({ answer: () => (offline ? new Error("annai couldn't reach sink.example (Failed to fetch). Is the device offline?") : new Response('{}')) });
  k.give(...Array.from({ length: 2500 }, (_, i) => entry(i + 1)));
  await k.clock.advance(BATCH_MS);
  assert.ok(k.posts.length >= 1, 'it tried');
  assert.deepEqual(k.cards, [], "a phone that's offline gets no card");
  const chip = k.drawChip();
  assert.match(chip.attrs.get('aria-label'), /^Sending trace: 2000 waiting, the server can't be reached$/);
  k.give(...Array.from({ length: 10 }, (_, i) => entry(3000 + i)));
  offline = false;
  const tried = k.posts.length;
  await k.clock.advance(RETRY_MAX_MS * 2);
  const sent = k.posts.slice(tried);
  const seqs = sent.flatMap((p) => p.body.entries.map((/** @type {any} */ e) => e.seq));
  assert.equal(seqs.length, KEEP_MAX);
  assert.deepEqual(seqs.slice(0, 2), [511, 512], 'the oldest went first');
  assert.deepEqual(seqs.slice(-2), [3008, 3009]);
  assert.equal(sent[0].body.dropped, 510);
  assert.equal(sent.slice(1).reduce((n, p) => n + p.body.dropped, 0), 0, 'counted once');
  assert.equal(chip.attrs.get('aria-label'), 'Sending trace');
  k.stop();
});

test('a failed try waits 3 s, then twice as long each time up to 60 s; one that works starts again at 3 s', async () => {
  let fail = true;
  const k = await kit({ answer: () => (fail ? new Error('Load failed') : new Response('{}')) });
  k.give(entry(1));
  await k.clock.advance(BATCH_MS);
  await k.clock.advance(400_000);
  const gaps = k.posts.slice(1).map((p, i) => p.at - k.posts[i].at);
  assert.deepEqual(gaps.slice(0, 7), [RETRY_MS, 6000, 12_000, 24_000, 48_000, RETRY_MAX_MS, RETRY_MAX_MS]);
  fail = false;
  await k.clock.advance(RETRY_MAX_MS);
  const worked = k.posts.length;
  fail = true;
  k.give(entry(2));
  await k.clock.advance(BATCH_MS + RETRY_MS);
  assert.equal(k.posts.length, worked + 2);
  assert.equal(k.posts.at(-1).at - k.posts.at(-2).at, RETRY_MS);
  k.stop();
});

test('a server that keeps refusing gives one card in plain words, not one per batch; once it takes a batch, a new run of refusals may give another', async () => {
  let status = 401;
  const k = await kit({ answer: () => new Response('{"error":"token"}', { status }) });
  k.give(entry(1));
  await k.clock.advance(BATCH_MS);
  await k.clock.advance(RETRY_MS + 6000);
  assert.equal(k.posts.length, REFUSALS);
  assert.equal(k.cards.length, 1);
  const [c] = k.cards;
  assert.equal(c.tone, 'warn');
  assert.equal(c.title, 'The trace server refuses what annai sends');
  assert.equal(c.body, 'sink.example answered 401 3 times in a row: the token may be wrong. annai keeps trying about once a minute, and keeps the newest 2,000 entries until they go. Check the server address and the token in Settings → Plugins → Remote trace (for developers), or turn Send off there.');
  await k.clock.advance(10 * RETRY_MAX_MS);
  assert.ok(k.posts.length > REFUSALS + 5);
  assert.equal(k.cards.length, 1, 'still one card');
  const chip = k.drawChip();
  assert.equal(chip.attrs.get('aria-label'), 'Sending trace: 1 waiting, the server answered 401');
  status = 200;
  await k.clock.advance(RETRY_MAX_MS);
  status = 500;
  k.give(entry(2));
  await k.clock.advance(BATCH_MS + RETRY_MS + 6000);
  assert.equal(k.cards.length, 2);
  assert.match(k.cards[1].body, /^sink\.example answered 500 3 times in a row\. annai keeps trying/);
  // Drawn, the chip lets the card open the plugin's page.
  assert.equal(k.cards[1].actions[0].label, 'Open Remote trace');
  k.cards[1].actions[0].run();
  assert.deepEqual(k.went, ['#/plugins/remote-trace']);
  k.stop();
});

test('location points are left out unless Send location points is on; turned off, the ones waiting go too', async () => {
  const k = await kit();
  const at = (/** @type {number} */ seq) => entry(seq, 'location', { lat: 36.27, lng: -121.8, accuracy: 8 });
  k.give(entry(1), at(2), entry(3));
  await k.clock.advance(BATCH_MS);
  assert.deepEqual(k.posts[0].body.entries.map((/** @type {any} */ e) => e.type), ['msg.user', 'msg.user']);
  await k.save({ location: true });
  k.give(at(4));
  await k.clock.advance(BATCH_MS);
  assert.deepEqual(k.posts.flatMap((p) => p.body.entries.map((/** @type {any} */ e) => e.seq)).filter((s) => s === 4), [4]);
  k.give(at(5), entry(6));
  await k.save({ location: false });
  await k.clock.advance(BATCH_MS);
  assert.ok(!k.posts.flatMap((p) => p.body.entries.map((/** @type {any} */ e) => e.seq)).includes(5));
  k.stop();
});

test('no key and no token in any body it posts: every secret annai keeps, and anything shaped like a credential, is blanked', async () => {
  const MODEL_KEY = 'sk-planted-model-key-0123456789';
  const k = await kit({ secrets: { 'endpoint:stand-in:key': MODEL_KEY, 'plugin:storage-s3:secret': 'planted-s3-secret-abcdef' } });
  k.give(
    entry(1, 'msg.user', { text: `my token is ${TOKEN} and my key is ${MODEL_KEY}` }),
    entry(2, 'error', { message: `Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 failed`, url: `https://x.example/a?api_key=${encodeURIComponent(MODEL_KEY)}` }),
    entry(3, 'tool.result', { content: ['planted-s3-secret-abcdef', { deep: TOKEN.toUpperCase() }] }),
  );
  await k.clock.advance(BATCH_MS);
  const body = k.posts[0].init.body;
  for (const s of [TOKEN, MODEL_KEY, encodeURIComponent(MODEL_KEY), 'planted-s3-secret-abcdef', 'abcdefghijklmnopqrstuvwxyz0123']) assert.ok(!body.toLowerCase().includes(s.toLowerCase()), s);
  assert.match(body, /my token is «key» and my key is «key»/);
  assert.match(body, /Bearer «key»/);
  k.stop();
});

test('Send off stops everything at once: the request under way is cut off, nothing waiting goes, the chip goes; Send on again starts afresh', async () => {
  /** @type {((r: Response) => void) | null} */
  let release = null;
  const k = await kit({ answer: (_n, init) => new Promise((resolve, reject) => {
    release = resolve;
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
  }) });
  assert.equal(k.chips.size, 1, 'the chip shows while it is on');
  k.give(...Array.from({ length: 100 }, (_, i) => entry(i + 1)));
  await k.clock.advance(0);
  assert.equal(k.posts.length, 1, 'a request under way');
  k.give(entry(500));
  await k.save({ send: false });
  assert.equal(k.posts[0].init.signal.aborted, true);
  assert.equal(k.chips.size, 0);
  /** @type {any} */ (release)?.(new Response('{}'));
  await k.clock.advance(10 * RETRY_MAX_MS);
  k.give(entry(501));
  await k.clock.advance(BATCH_MS);
  assert.equal(k.posts.length, 1, 'nothing sent after it went off, and nothing collected while off');
  await k.save({ send: true });
  assert.equal(k.chips.size, 1);
  k.give(entry(502));
  await k.clock.advance(BATCH_MS);
  assert.deepEqual(k.posts.slice(1).flatMap((p) => p.body.entries.map((/** @type {any} */ e) => e.seq)), [502]);
  // Turned off (or removed), the cleanup does the same.
  k.give(entry(503));
  k.stop();
  assert.equal(k.chips.size, 0);
  assert.equal(k.hooked(), false);
  await k.clock.advance(BATCH_MS * 10);
  assert.equal(k.posts.length, 2);
});

test('the chip reads Trace, is named Sending trace, and a tap or Enter opens the plugin\'s page', async () => {
  const k = await kit();
  const { el, attrs, on, cleanup } = k.drawChip();
  assert.equal(el.textContent, 'Trace');
  assert.equal(attrs.get('role'), 'button');
  assert.equal(attrs.get('aria-label'), 'Sending trace');
  assert.equal(el.title, 'Sending trace');
  assert.equal(el.tabIndex, 0);
  on.get('click')?.({});
  let prevented = false;
  on.get('keydown')?.({ key: 'Enter', preventDefault: () => { prevented = true; } });
  on.get('keydown')?.({ key: 'a', preventDefault: () => {} });
  assert.deepEqual(k.went, ['#/plugins/remote-trace', '#/plugins/remote-trace']);
  assert.equal(prevented, true);
  cleanup();
  assert.equal(on.size, 0);
  k.stop();
});

test('off until configured: no Send, no address, an address annai may not use, or no token, and nothing is sent; a plain card says what is missing', async () => {
  const quiet = await kit({ settings: { server: SERVER } });
  quiet.give(entry(1));
  await quiet.clock.advance(BATCH_MS * 2);
  assert.deepEqual([quiet.posts.length, quiet.chips.size, quiet.cards.length], [0, 0, 0], 'Send off: nothing at all, not even a card');
  quiet.stop();
  /** @type {[string, RegExp][]} */
  const wrong = [['', /needs the address of your server/], ['http://sink.example/', /must start with https:\/\//], ['ftp://sink.example', /must start with https:\/\//]];
  for (const [server, words] of wrong) {
    const k = await kit({ settings: { server, send: true } });
    k.give(entry(1));
    await k.clock.advance(BATCH_MS * 2);
    assert.deepEqual([k.posts.length, k.chips.size, k.cards.length], [0, 0, 1], server);
    assert.equal(k.cards[0].title, "Remote trace isn't sending");
    assert.match(k.cards[0].body, words);
    k.stop();
  }
  const noToken = await kit({ token: null });
  noToken.give(entry(1));
  await noToken.clock.advance(BATCH_MS * 2);
  assert.deepEqual([noToken.posts.length, noToken.chips.size, noToken.cards.length], [0, 0, 1]);
  assert.match(noToken.cards[0].body, /needs the server's token/);
  noToken.stop();
});

test('the server address: https anywhere, http only on this device (annai\'s CSP)', () => {
  for (const ok of ['https://sink.example', 'https://a.b.example:8443/trace?x=1', 'http://localhost:8798/', 'http://127.0.0.1:1', ' https://padded.example ']) assert.equal(serverProblem(ok), null, ok);
  for (const bad of ['http://sink.example', 'http://192.168.1.5:8798', 'http://[::1]:8798', 'ws://localhost', 'sink.example', 'not an address', '']) assert.ok(serverProblem(bad), bad);
});

test("annai's version and build come from its service worker's offline copy, the oldest one while an update waits; sw.js still names it so", async () => {
  assert.deepEqual(shellBuild(['annai-inbox', 'annai-shell-0.1.0-96fe727820fb']), { app: 'annai 0.1.0', build: '96fe727820fb' });
  assert.deepEqual(shellBuild(['annai-shell-0.2.0-rc.1-aaaaaaaaaaaa', 'annai-shell-0.2.0-rc.1-bbbbbbbbbbbb']), { app: 'annai 0.2.0-rc.1', build: 'aaaaaaaaaaaa' });
  assert.deepEqual(shellBuild(['annai-push', 'other']), { app: 'annai', build: null });
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  assert.match(sw, /^const CACHE = `annai-shell-\$\{VERSION\}-\$\{BUILD\}`;$/m);
  const version = /^const VERSION = '([^']+)';$/m.exec(sw)?.[1];
  const build = /^const BUILD = '([^']+)';$/m.exec(sw)?.[1];
  assert.deepEqual(shellBuild([`annai-shell-${version}-${build}`]), { app: `annai ${version}`, build });
});

/** The real package, installed into a real plugin host on memory storage, started on a virtual clock. */
async function hosted({ answer = () => new Response('{}') } = {}) {
  const clock = virtualClock();
  const { host, ws, store, registry, log } = await hostKit();
  const dir = new URL('plugins-official/remote-trace/', root);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const name of await readdir(dir)) files.set(name, new Uint8Array(await readFile(new URL(name, dir))));
  /** @type {{ url: string, body: string }[]} */
  const posts = [];
  /** @type {any[]} */
  const cards = [];
  host.connect({
    notices: { card: (/** @type {any} */ c) => cards.push(c), toast: () => {} },
    fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
      posts.push({ url, body: init.body });
      const a = await answer();
      if (a instanceof Error) throw a;
      return a;
    },
  });
  // The real module, started on the test's clock, where the host would import it from storage.
  const load = host.importModule;
  host.importModule = async (/** @type {string} */ url) => (url === '/plugins/remote-trace/index.js'
    ? { activate: (/** @type {any} */ api) => start(api, { timers: clock.timers, now: clock.now, cacheNames: async () => [] }) }
    : load(url));
  await host.install(files, { source: 'official' });
  await host.start('remote-trace');
  return { clock, host, ws, store, registry, log, posts, cards };
}

/** The user turns Send on with a server and a token, as the plugin's form saves them. @param {any} ws @param {any} store */
async function configure(ws, store, settings = { server: SERVER, send: true }) {
  await ws.patch(SYS_SETTINGS, SETTINGS_FILE, settings, { author: 'user', create: true });
  await store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.putSecret('plugin:remote-trace:token', TOKEN));
  await settle();
}

test("in annai's plugin host: everything the user does reaches the server, never the plugin's own requests or its device id, so it doesn't loop", async () => {
  const h = await hosted();
  await configure(h.ws, h.store);
  assert.equal(h.registry.entries('ui:status-chip').length, 1);
  await h.ws.write('me', '/notes/a.md', 'hi', { author: 'user' });
  await logEvent(h.store, SYS, { type: 'error', data: { message: 'boom' } });
  await h.clock.advance(BATCH_MS);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].url, SERVER);
  const sent = JSON.parse(h.posts[0].body).entries;
  // The settings write that turned it on came before it was on.
  assert.deepEqual(sent.map((/** @type {any} */ e) => [e.scope, e.type, e.actor]), [['me', 'file.write', 'user'], [SYS, 'error', 'system']]);
  // Its request is in the trace, signed by it; it never comes back to it.
  const traced = (await h.log()).filter((e) => e.type === 'net.request' && e.data.tool === 'plugin:remote-trace');
  assert.equal(traced.length, 1);
  assert.equal(traced[0].data.status, 200);
  assert.ok(!JSON.stringify(traced).includes(TOKEN));
  await h.clock.advance(10 * BATCH_MS);
  assert.equal(h.posts.length, 1, 'its own request and its device id write sent nothing more');
  const device = JSON.parse(h.posts[0].body).device;
  assert.equal((await h.ws.readJSON(SYS_SETTINGS, SETTINGS_FILE)).device, device);
  await h.host.stop('remote-trace');
});

test("in annai's plugin host: a key typed into a message never reaches the server; Turn off stops it; Remove takes its settings, device id and token", async () => {
  const MODEL_KEY = 'sk-planted-model-key-0123456789';
  const h = await hosted();
  await h.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.putSecret('endpoint:stand-in:key', MODEL_KEY));
  await configure(h.ws, h.store);
  await logEvent(h.store, 'me', { type: 'msg.user', actor: 'user', data: { text: `key ${MODEL_KEY} token ${TOKEN}` } });
  await h.clock.advance(BATCH_MS);
  assert.equal(h.posts.length, 1);
  assert.ok(!h.posts[0].body.includes(MODEL_KEY) && !h.posts[0].body.includes(TOKEN));
  assert.match(h.posts[0].body, /key «key» token «key»/);
  await h.host.setEnabled('remote-trace', false);
  assert.equal(h.registry.entries('ui:status-chip').length, 0);
  await logEvent(h.store, 'me', { type: 'msg.user', actor: 'user', data: { text: 'after' } });
  await h.clock.advance(10 * BATCH_MS);
  assert.equal(h.posts.length, 1, 'off: nothing more');
  await h.host.setEnabled('remote-trace', true);
  await h.host.uninstall('remote-trace');
  assert.equal(await h.ws.readJSON(SYS_SETTINGS, SETTINGS_FILE), undefined);
  assert.equal((await h.ws.history(SYS_SETTINGS, SETTINGS_FILE)).length, 0);
  assert.equal(await h.store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret('plugin:remote-trace:token')), undefined);
  assert.deepEqual((await h.ws.list(SYS_PLUGINS, '/remote-trace/')).length, 0);
  assert.equal(await h.store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret('endpoint:stand-in:key')), MODEL_KEY, "others' keys stay");
});

test('the package: an official plugin with the settings form the brief asks for, and activate', async () => {
  const manifest = JSON.parse(await readFile(new URL('plugins-official/remote-trace/annai-plugin.json', root), 'utf8'));
  assert.equal(manifest.id, 'remote-trace');
  assert.equal(manifest.name, 'Remote trace (for developers)');
  assert.equal(manifest.api, 1);
  assert.equal(manifest.entry, 'index.js');
  assert.deepEqual(Object.keys(manifest.settings.properties), ['server', 'token', 'location', 'send']);
  const p = manifest.settings.properties;
  assert.deepEqual([p.server.type, p.token.type, p.token.writeOnly, p.location.default, p.send.default], ['string', 'string', true, false, false]);
  assert.deepEqual([p.server.title, p.token.title, p.location.title, p.send.title], ['Server address', 'Token', 'Send location points', 'Send']);
  assert.equal(typeof activate, 'function');
  const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8'));
  const listed = catalog.plugins.find((/** @type {any} */ x) => x.id === 'remote-trace');
  assert.deepEqual(Object.keys(listed.files).sort(), ['annai-plugin.json', 'index.js']);
  assert.ok(utf8(JSON.stringify(manifest)).length < 4000);
});
