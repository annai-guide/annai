import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { utf8 } from '../../src/core/bytes.js';
import { logEvent } from '../../src/core/events.js';
import { withoutSecretsIn } from '../../src/core/agent/net.js';
import { SYS, SYS_SETTINGS, SYS_PLUGINS } from '../../src/core/scopes.js';
import { start, activate, serverProblem, shellBuild, clipAddress, screenText, BATCH_MS, BATCH_MAX, KEEP_MAX, KEEP_BYTES, BATCH_BYTES, ENTRY_BYTES, RETRY_MS, RETRY_MAX_MS, REFUSALS, SETTINGS_FILE, DETAIL_MS, CLIPS_KEEP_BYTES, FLAG_MS, SCREEN_CHARS, SCREEN_SETTLE_MS } from '../../plugins-official/remote-trace/index.js';
import { hostKit } from './package-kit.js';
import { pluginWords } from './l10n-kit.js';

const root = new URL('../../', import.meta.url);
const T0 = 1_800_000_000_000;
const TOKEN = 'rt-token-0123456789abcdef';
const SERVER = 'https://sink.example/trace';

/** Lets every pending promise and I/O turn run. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Waits, in real time, until what a test expects has happened. The host's writes hash their content with WebCrypto, which
 * Node runs on its thread pool, so a busy machine can take longer than any number of turns of the event loop.
 * @param {() => boolean} ok @param {string} what
 */
async function until(ok, what, ms = 5000) {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) assert.fail(`waited ${ms} ms for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

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
    /** Moves on ms with no timer running: a phone asleep, whose page's timers stood still. @param {number} ms */
    jump(ms) {
      t += ms;
    },
    /** Moves on ms, running each timer that comes due on the way, and what it starts. @param {number} ms */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        const next = [...due].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        due.delete(next[0]);
        t = Math.max(t, next[1].at); // a jump has moved the clock past it: time never runs back
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
 * online: whether the browser says it is online, which the test changes with goOnline/goOffline.
 * @param {{ settings?: any, token?: string | null, answer?: (n: number, init: any) => Response | Error | Promise<Response>, secrets?: Record<string, string>, online?: boolean, startAt?: number, screen?: () => { route: string, text: string } }} [o]
 */
async function kit({ settings = { server: SERVER, send: true }, token = TOKEN, answer = () => new Response('{}'), secrets = {}, online = true, startAt = T0, screen = () => ({ route: '#/now', text: 'on screen' }) } = {}) {
  let isOnline = online;
  /** @type {Set<any>} */
  const tapped = new Set();
  /** @type {Set<() => void>} */
  const routes = new Set();
  /** @type {any[]} */
  const appended = [];
  /** @type {string[]} */
  const toasts = [];
  /** @type {Set<() => void>} */
  const backOnline = new Set();
  const clock = virtualClock(startAt);
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
    register: (/** @type {string} */ what, /** @type {any} */ item) => {
      assert.equal(what, 'heard-clips');
      tapped.add(item);
      return () => tapped.delete(item);
    },
    // As annai does it: a plugin's own entries never reach its hook.
    events: {
      append: async (/** @type {string} */ scope, /** @type {string} */ type, /** @type {any} */ data) => {
        const e = { scope, seq: 1000 + appended.length, ts: clock.now(), type, actor: 'plugin:remote-trace', data };
        appended.push(e);
        return e;
      },
    },
    hooks: { on: (/** @type {any} */ fn) => { hook = fn; return () => { hook = null; }; } },
    settings: {
      get: async () => ({ location: false, send: false, ...saved }),
      set: async (/** @type {any} */ c) => { Object.assign(saved, c); },
    },
    secrets: {
      get: async (/** @type {string} */ n) => (await store.tx(['secrets'], 'readonly', (t) => t.getSecret(`plugin:remote-trace:${n}`))) ?? null,
      // What annai.secrets.blank does (src/core/plugins.js).
      blank: (/** @type {any} */ v) => withoutSecretsIn(store, v, { strict: true }),
    },
    net: {
      fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
        posts.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, at: clock.now() });
        const a = await answer(posts.length, init);
        if (a instanceof Error) throw a;
        return a;
      },
    },
    l10n: pluginWords(),
    ui: {
      slot: (/** @type {string} */ slot, /** @type {any} */ item) => {
        assert.equal(slot, 'status-chip');
        chips.set(item.id, item);
        return () => chips.delete(item.id);
      },
      card: (/** @type {any} */ c) => cards.push(c),
      toast: (/** @type {string} */ words) => toasts.push(words),
    },
  };
  const stop = start(annai, {
    timers: clock.timers, now: clock.now, cacheNames: async () => ['annai-inbox', 'annai-shell-0.1.0-96fe727820fb'],
    online: () => isOnline, onOnline: (/** @type {() => void} */ fn) => { backOnline.add(fn); return () => backOnline.delete(fn); },
    screen, onRoute: (/** @type {() => void} */ fn) => { routes.add(fn); return () => routes.delete(fn); },
  });
  await settle();
  return {
    clock, store, saved, posts, cards, chips, went, stop, tapped, appended, toasts,
    /** The microphone heard a clip, as annai's voice tells a plugin. @param {string} id @param {number} [bytes] */
    hear: (id, bytes = 100) => { for (const t of tapped) t.clip({ id, kind: 'turn', format: 'ogg', mediaType: 'audio/ogg', data: new Uint8Array(bytes).fill(7), ms: 1000 }); },
    /** The screen changes route. */
    route: () => { for (const fn of routes) fn(); },
    /** A tap on the Flag chip. */
    tapFlag: async () => {
      /** @type {Map<string, any>} */
      const on = new Map();
      chips.get('flag').render({ setAttribute() {}, addEventListener: (/** @type {string} */ k, /** @type {any} */ fn) => on.set(k, fn), removeEventListener() {} });
      on.get('click')();
      await settle();
    },
    /** Hands the plugin's hook log entries, as annai would. @param {any[]} es */
    give: (...es) => { for (const e of es) hook?.(e); },
    goOffline: () => { isOnline = false; },
    goOnline: async () => {
      isOnline = true;
      for (const fn of backOnline) fn();
      await clock.advance(0);
    },
    listening: () => backOnline.size,
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
  assert.match(chip.attrs.get('aria-label'), /^Sending trace: 2,000 waiting\. The server can't be reached\.$/);
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
  assert.equal(chip.attrs.get('aria-label'), 'Sending trace: 1 waiting. The server answered 401.');
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
  {
    // Send on with no token: it stays on, says so once, and keeps what waits.
    const k = await kit({ token: null });
    k.give(entry(1));
    await k.clock.advance(BATCH_MS + RETRY_MS + 6000 + 12_000);
    assert.deepEqual([k.posts.length, k.chips.size, k.cards.length], [0, 1, 1]);
    assert.equal(k.cards[0].body, "It needs the server's token. Add it in Settings → Plugins → Remote trace (for developers).");
    assert.equal(k.drawChip().attrs.get('aria-label'), 'Sending trace: 1 waiting. It has no token.');
    // The form saves only the token: the settings file doesn't change, so no entry tells the plugin. The next try reads it.
    await k.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:remote-trace:token', TOKEN));
    await k.clock.advance(RETRY_MAX_MS);
    assert.equal(k.posts.length, 1);
    assert.deepEqual(k.posts[0].body.entries.map((/** @type {any} */ e) => e.seq), [1]);
    assert.equal(k.cards.length, 1);
    k.stop();
  }
});

test("a token or address a request can't carry gives one card and no request: a name and password in the address, a token with letters a header can't hold; a token's spaces are trimmed", async () => {
  assert.match(String(serverProblem('https://me:secret@sink.example/trace', pluginWords())), /name or password/);
  const odd = await kit({ token: 'tökén-0123456789abcdef' });
  odd.give(entry(1));
  await odd.clock.advance(BATCH_MS + RETRY_MS + 6000 + 12_000);
  assert.deepEqual([odd.posts.length, odd.cards.length], [0, 1]);
  assert.match(odd.cards[0].body, /^Its token has characters a request can't carry/);
  odd.stop();
  const padded = await kit({ token: `  ${TOKEN}\n` });
  padded.give(entry(1));
  await padded.clock.advance(BATCH_MS);
  assert.equal(new Headers(padded.posts[0].init.headers).get('authorization'), `Bearer ${TOKEN}`);
  padded.stop();
});

test('offline, what waits is capped by size too: past 4 MiB the oldest go first, and are counted', async () => {
  let fail = true;
  const k = await kit({ answer: () => (fail ? new Error('Load failed') : new Response('{}')) });
  const big = (/** @type {number} */ seq) => entry(seq, 'tool.call', { name: 'write', input: { text: 'x'.repeat(60 * 1024) } });
  k.give(...Array.from({ length: 200 }, (_, i) => big(i + 1)));
  await k.clock.advance(BATCH_MS);
  fail = false;
  const tried = k.posts.length;
  await k.clock.advance(2 * RETRY_MAX_MS);
  const sent = k.posts.slice(tried);
  const seqs = sent.flatMap((p) => p.body.entries.map((/** @type {any} */ e) => e.seq));
  const bytes = sent.flatMap((p) => p.body.entries).reduce((n, e) => n + utf8(JSON.stringify(e)).length, 0);
  assert.ok(bytes <= KEEP_BYTES, `${bytes} bytes kept`);
  assert.ok(seqs.length > 50 && seqs.length < 200, `${seqs.length} kept`);
  assert.equal(seqs.at(-1), 200, 'the newest are kept');
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => 200 - seqs.length + 1 + i), 'the oldest went first');
  assert.equal(sent.reduce((n, p) => n + p.body.dropped, 0), 200 - seqs.length);
  k.stop();
});

test("while the browser says it is offline, it doesn't try; when it is back online, it tries at once", async () => {
  let fail = true;
  const k = await kit({ online: false, answer: () => (fail ? new Error('Load failed') : new Response('{}')) });
  k.give(entry(1));
  await k.clock.advance(10 * RETRY_MAX_MS);
  assert.equal(k.posts.length, 0, 'no tries while offline');
  assert.equal(k.drawChip().attrs.get('aria-label'), 'Sending trace: 1 waiting. The phone is offline.');
  fail = false;
  await k.goOnline();
  assert.equal(k.posts.length, 1, 'at once');
  // Offline after a failed try: the retry that comes due waits for the browser to be online.
  fail = true;
  k.give(entry(2));
  await k.clock.advance(BATCH_MS);
  assert.equal(k.posts.length, 2);
  k.goOffline();
  await k.clock.advance(5 * RETRY_MAX_MS);
  assert.equal(k.posts.length, 2);
  fail = false;
  await k.goOnline();
  assert.equal(k.posts.length, 3);
  assert.deepEqual(k.posts[2].body.entries.map((/** @type {any} */ e) => e.seq), [2]);
  k.stop();
  assert.equal(k.listening(), 0, 'stopped, it no longer listens');
});

test('a server that answers 413 or 400 gets half the batch, and an entry it still refuses alone is dropped and counted, so one bad entry never blocks the rest', async () => {
  const k = await kit({ answer: (_n, init) => {
    const { entries } = JSON.parse(init.body);
    if (entries.length > 10) return new Response('too big', { status: 413 });
    if (entries.some((/** @type {any} */ e) => e.data?.text === 'poison')) return new Response('bad', { status: 400 });
    return new Response('{}');
  } });
  k.give(...Array.from({ length: 100 }, (_, i) => entry(i + 1, 'msg.user', { text: i === 41 ? 'poison' : `hello ${i + 1}` })));
  await k.clock.advance(30 * RETRY_MS);
  const took = k.posts.filter((p) => p.body.entries.length <= 10 && !p.body.entries.some((/** @type {any} */ e) => e.data.text === 'poison'));
  const seqs = took.flatMap((p) => p.body.entries.map((/** @type {any} */ e) => e.seq));
  assert.deepEqual(seqs, Array.from({ length: 100 }, (_, i) => i + 1).filter((n) => n !== 42), 'all but the one it refused, in order');
  assert.deepEqual(k.posts.slice(0, 4).map((p) => p.body.entries.length), [100, 50, 25, 12]);
  assert.equal(took.reduce((n, p) => n + p.body.dropped, 0), 1);
  for (let i = 1; i < 6; i++) assert.ok(k.posts[i].at - k.posts[i - 1].at <= RETRY_MS, 'halving waits no longer than a first retry');
  k.stop();
});

test('the server address: https anywhere, http only on this device (annai\'s CSP)', () => {
  for (const ok of ['https://sink.example', 'https://a.b.example:8443/trace?x=1', 'http://localhost:8798/', 'http://127.0.0.1:1', ' https://padded.example ']) assert.equal(serverProblem(ok, pluginWords()), null, ok);
  for (const bad of ['http://sink.example', 'http://192.168.1.5:8798', 'http://[::1]:8798', 'ws://localhost', 'sink.example', 'not an address', '']) assert.ok(serverProblem(bad, pluginWords()), bad);
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
  // Its files, its translations' folder too.
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) { const name = relative(fileURLToPath(dir), join(e.parentPath, e.name)); files.set(name, new Uint8Array(await readFile(new URL(name, dir)))); }
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
  await until(() => h.posts.length >= 1, '1 post');
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
  await until(() => h.posts.length >= 1, '1 post');
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

test("in annai's plugin host: annai.secrets.blank fails closed, so when the secrets can't be read nothing is posted; the batch waits and goes once they can", async () => {
  const MODEL_KEY = 'sk-planted-model-key-0123456789';
  const h = await hosted();
  await h.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.putSecret('endpoint:stand-in:key', MODEL_KEY));
  await configure(h.ws, h.store);
  const tx = h.store.tx;
  // Reading one secret works (the token); listing them all, which blanking needs, fails.
  h.store.tx = /** @type {any} */ ((/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => tx.call(h.store, stores, mode, (/** @type {any} */ t) => fn(stores.includes('secrets') ? { ...t, listSecretIds: () => Promise.reject(new Error('The database connection is closing.')) } : t)));
  await logEvent(h.store, 'me', { type: 'msg.user', actor: 'user', data: { text: `key ${MODEL_KEY}` } });
  await h.clock.advance(BATCH_MS + RETRY_MS + 6000);
  assert.equal(h.posts.length, 0, 'nothing went out unblanked');
  h.store.tx = tx;
  await h.clock.advance(RETRY_MAX_MS);
  await until(() => h.posts.length >= 1, '1 post');
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].body, /key «key»/);
  assert.ok(!h.posts[0].body.includes(MODEL_KEY));
  await h.host.stop('remote-trace');
});

test("in annai's plugin host: switched off by annai (its hooks handed over 1,000 entries in 10 s), it stops at once and sends nothing more; turned on again, it works", async () => {
  const h = await hosted();
  await configure(h.ws, h.store);
  for (let i = 0; i < 1001; i++) await logEvent(h.store, 'me', { type: 'msg.user', actor: 'user', data: { text: `m${i}` } });
  await settle();
  assert.equal(h.registry.isDisabled('remote-trace'), true);
  assert.equal(h.host.active.has('remote-trace'), false, 'stopped, so its cleanup ran');
  await h.clock.advance(20 * BATCH_MS);
  assert.equal(h.posts.length, 0);
  await h.host.setEnabled('remote-trace', true);
  assert.equal(h.registry.isDisabled('remote-trace'), false);
  assert.equal(h.registry.entries('ui:status-chip').length, 1);
  await logEvent(h.store, 'me', { type: 'msg.user', actor: 'user', data: { text: 'back' } });
  await h.clock.advance(BATCH_MS);
  await until(() => h.posts.length >= 1, '1 post');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(JSON.parse(h.posts[0].body).entries.map((/** @type {any} */ e) => e.data.text), ['back']);
  await h.host.stop('remote-trace');
});

test("in annai's plugin host: Reset turns it off at once and forgets its device id; set up again, it sends as a new device", async () => {
  const h = await hosted();
  await configure(h.ws, h.store);
  await logEvent(h.store, 'me', { type: 'msg.user', actor: 'user', data: { text: 'one' } });
  await h.clock.advance(BATCH_MS);
  await until(() => h.posts.length >= 1, 'the first post');
  const first = JSON.parse(h.posts[0].body).device;
  await logEvent(h.store, 'me', { type: 'msg.user', actor: 'user', data: { text: 'waiting' } });
  await h.host.reset('remote-trace');
  await settle();
  assert.equal(h.registry.entries('ui:status-chip').length, 0);
  assert.equal(await h.ws.readJSON(SYS_SETTINGS, SETTINGS_FILE), undefined);
  await h.clock.advance(10 * BATCH_MS);
  assert.equal(h.posts.length, 1, 'what waited went with it');
  await configure(h.ws, h.store);
  await logEvent(h.store, 'me', { type: 'msg.user', actor: 'user', data: { text: 'two' } });
  await h.clock.advance(BATCH_MS);
  await until(() => h.posts.length >= 2, '2 posts');
  assert.equal(h.posts.length, 2);
  const again = JSON.parse(h.posts[1].body);
  assert.deepEqual(again.entries.map((/** @type {any} */ e) => e.data.text), ['two']);
  assert.match(again.device, /^[0-9a-f]{16}$/);
  assert.notEqual(again.device, first);
  await h.host.stop('remote-trace');
});

test('the package: an official plugin with the settings form the brief asks for, and activate', async () => {
  const manifest = JSON.parse(await readFile(new URL('plugins-official/remote-trace/annai-plugin.json', root), 'utf8'));
  assert.equal(manifest.id, 'remote-trace');
  assert.equal(manifest.name, 'Remote trace (for developers)');
  assert.equal(manifest.api, 2, 'it reads annai.l10n');
  assert.equal(manifest.entry, 'index.js');
  assert.deepEqual(Object.keys(manifest.settings.properties), ['server', 'token', 'location', 'send', 'detailed', 'device']);
  assert.deepEqual([manifest.settings.properties.device.type, manifest.settings.properties.device.title, manifest.settings.properties.device.maxLength], ['string', 'Device id', 64]);
  const p = manifest.settings.properties;
  assert.deepEqual([p.server.type, p.token.type, p.token.writeOnly, p.location.default, p.send.default], ['string', 'string', true, false, false]);
  assert.deepEqual([p.server.title, p.token.title, p.location.title, p.send.title], ['Server address', 'Token', 'Send location points', 'Send']);
  assert.equal(typeof activate, 'function');
  const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8'));
  const listed = catalog.plugins.find((/** @type {any} */ x) => x.id === 'remote-trace');
  assert.deepEqual(Object.keys(listed.files).sort(), ['annai-plugin.json', 'index.js'], 'its words are beside the catalog, not in its package');
  assert.ok(utf8(JSON.stringify(manifest)).length < 4000);
});

// Detailed trace (the second-drive design, section 7).
const ON = { server: SERVER, send: true, detailed: true };
/** What went to the clips address. @param {any} k */
const clipPosts = (k) => k.posts.filter((/** @type {any} */ p) => new URL(p.url).pathname.endsWith('/clips'));
/** @param {any} k @param {string} type */
const logged = (k, type) => k.appended.filter((/** @type {any} */ e) => e.type === type);

test('Detailed trace off, the default: annai hears no one, no clip leaves, no flag shows, no screen is copied', async () => {
  const k = await kit();
  assert.equal(k.tapped.size, 0);
  assert.equal(k.chips.has('flag'), false);
  k.route();
  await k.clock.advance(60_000);
  assert.equal(k.appended.length, 0);
  assert.equal(clipPosts(k).length, 0);
  k.stop();
});

test('with no server, or Send off, there is nothing to turn on: the switch goes back off and says why, and turning those on later starts nothing', async () => {
  const none = await kit({ settings: { send: false, detailed: true } });
  assert.equal(none.saved.detailed, false);
  assert.equal(none.tapped.size, 0);
  assert.match(none.cards[0].body, /server address and Send on/);
  await none.save({ server: SERVER, send: true });
  assert.equal(none.tapped.size, 0, 'it never starts by itself');
  none.stop();
  const noServer = await kit({ settings: { send: true, detailed: true } });
  assert.equal(noServer.saved.detailed, false);
  assert.equal(noServer.chips.has('flag'), false);
  assert.equal(noServer.cards.length, 1, 'the card about the server is enough');
  noServer.stop();
});

test('on, each clip goes to <server>/clips as its bytes, named by device and id, signed with the token, and its entry goes with the batches', async () => {
  const k = await kit({ settings: ON });
  assert.equal(k.tapped.size, 1);
  assert.equal(k.chips.has('flag'), true);
  k.hear('h-1');
  await k.clock.advance(0);
  const [p] = clipPosts(k);
  const u = new URL(p.url);
  assert.equal(u.origin + u.pathname, `${SERVER}/clips`);
  assert.equal(u.searchParams.get('id'), 'h-1');
  assert.equal(u.searchParams.get('format'), 'ogg');
  assert.equal(u.searchParams.get('device'), k.saved.device);
  assert.equal(p.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(p.init.headers['content-type'], 'audio/ogg');
  assert.equal(p.body.length, 100);
  await k.clock.advance(BATCH_MS);
  const sent = k.posts.filter((/** @type {any} */ x) => x.url === SERVER).flatMap((/** @type {any} */ x) => x.body.entries);
  assert.deepEqual(sent.map((/** @type {any} */ e) => [e.type, e.scope, e.data.id, e.data.bytes]), [['trace.clip', 'sys:device', 'h-1', 100]]);
  k.stop();
});

test('a clip address keeps the server path, whatever its slash', () => {
  assert.equal(clipAddress('https://sink.example/', { id: 'a' }), 'https://sink.example/clips?id=a');
  assert.equal(clipAddress('https://sink.example/trace', { id: 'a' }), 'https://sink.example/trace/clips?id=a');
});

test('turned off, the tap and the flag go at once, a clip on its way is dropped with what waits, and nothing more leaves', async () => {
  const k = await kit({ settings: ON, answer: () => new Response('{}', { status: 503 }) });
  k.hear('h-1');
  k.hear('h-2');
  await k.clock.advance(0);
  const before = clipPosts(k).length;
  const heard = [...k.tapped][0];
  await k.save({ detailed: false });
  assert.equal(k.tapped.size, 0);
  assert.equal(k.chips.has('flag'), false);
  heard.clip({ id: 'late', kind: 'turn', format: 'ogg', mediaType: 'audio/ogg', data: new Uint8Array(1), ms: 1 });
  await k.clock.advance(120_000);
  assert.equal(clipPosts(k).length, before);
  assert.equal(k.saved.detailedUntil, null, 'turned on again, it gets 24 hours of its own');
  k.stop();
});

test('it turns itself off after 24 hours, with a card, and stays off', async () => {
  const k = await kit({ settings: ON });
  assert.equal(k.saved.detailedUntil, T0 + DETAIL_MS);
  await k.clock.advance(DETAIL_MS - 1);
  assert.equal(k.tapped.size, 1);
  await k.clock.advance(1);
  assert.equal(k.tapped.size, 0);
  assert.equal(k.chips.has('flag'), false);
  assert.equal(k.saved.detailed, false);
  assert.equal(k.saved.detailedUntil, null);
  assert.equal(k.cards.length, 1);
  assert.match(k.cards[0].title, /turned itself off/);
  assert.equal(k.chips.has('sending'), true, 'Send stays on');
  k.stop();
});

test('its 24 hours survive a reload: a reload keeps the end it had, and one after the end comes up off', async () => {
  const first = await kit({ settings: ON });
  const until = first.saved.detailedUntil;
  first.stop();
  const again = await kit({ settings: { ...first.saved }, startAt: T0 + DETAIL_MS / 2 });
  assert.equal(again.saved.detailedUntil, until, 'a reload starts no new 24 hours');
  assert.equal(again.tapped.size, 1);
  await again.clock.advance(DETAIL_MS / 2);
  assert.equal(again.tapped.size, 0);
  again.stop();
  const later = await kit({ settings: { ...first.saved }, startAt: until + 1000 });
  assert.equal(later.tapped.size, 0);
  assert.equal(later.chips.has('flag'), false);
  assert.equal(later.saved.detailed, false);
  later.stop();
});

test('a phone asleep past the end, its timer not yet run: the next clip or tap finds it over, and nothing is taken', async () => {
  const k = await kit({ settings: ON });
  const heard = [...k.tapped][0];
  k.clock.jump(DETAIL_MS);
  heard.clip({ id: 'late', kind: 'turn', format: 'ogg', mediaType: 'audio/ogg', data: new Uint8Array(1), ms: 1 });
  await settle();
  assert.equal(k.tapped.size, 0);
  assert.equal(k.saved.detailed, false);
  assert.equal(k.appended.length, 0);
  await k.clock.advance(RETRY_MS);
  assert.equal(clipPosts(k).length, 0);
  k.stop();
});

test('clips wait within a byte cap with no signal: the oldest go, each counted in the log; back online the rest go', async () => {
  const k = await kit({ settings: ON, online: false });
  const size = Math.floor(CLIPS_KEEP_BYTES / 3);
  for (const id of ['a', 'b', 'c', 'd']) k.hear(id, size);
  await k.clock.advance(60_000);
  assert.equal(clipPosts(k).length, 0);
  assert.deepEqual(logged(k, 'trace.clip.dropped').map((/** @type {any} */ e) => [e.data.id, e.data.bytes]), [['a', size]]);
  await k.goOnline();
  await k.clock.advance(0);
  await k.clock.advance(0);
  await k.clock.advance(0);
  assert.deepEqual(clipPosts(k).map((/** @type {any} */ p) => new URL(p.url).searchParams.get('id')), ['b', 'c', 'd']);
  k.stop();
});

test('a failure backs off as batches do and keeps the clip; a refusal of that clip alone drops it, counted; batches go on meanwhile', async () => {
  let status = 503;
  const k = await kit({ settings: ON, answer: (_n, init) => new Response('{}', { status: typeof init.body === 'string' ? 200 : status }) });
  k.hear('a');
  await k.clock.advance(0);
  assert.equal(clipPosts(k).length, 1);
  await k.clock.advance(RETRY_MS - 1);
  assert.equal(clipPosts(k).length, 1);
  await k.clock.advance(1);
  assert.equal(clipPosts(k).length, 2);
  await k.clock.advance(RETRY_MS * 2);
  assert.equal(clipPosts(k).length, 3);
  await k.clock.advance(RETRY_MAX_MS * 10);
  const steps = clipPosts(k).map((/** @type {any} */ p) => p.at).map((/** @type {number} */ at, /** @type {number} */ i, /** @type {number[]} */ all) => (i ? at - all[i - 1] : 0));
  assert.ok(Math.max(...steps) <= RETRY_MAX_MS);
  status = 413;
  await k.clock.advance(RETRY_MAX_MS);
  const n = clipPosts(k).length;
  assert.equal(logged(k, 'trace.clip.dropped')[0].data.id, 'a');
  await k.clock.advance(RETRY_MAX_MS);
  assert.equal(clipPosts(k).length, n, 'not tried again');
  k.stop();
});

test('without a token a clip waits, no request goes, and saving the token is enough', async () => {
  const k = await kit({ settings: ON, token: null });
  k.hear('a');
  await k.clock.advance(RETRY_MS * 3);
  assert.equal(clipPosts(k).length, 0);
  await k.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('plugin:remote-trace:token', TOKEN));
  await k.clock.advance(RETRY_MAX_MS);
  assert.equal(clipPosts(k).length, 1);
  k.stop();
});

test('Flag writes the time and the screen copy, names the last clip, marks the next 30 s of clips, and says one word', async () => {
  const k = await kit({ settings: ON, screen: () => ({ route: '#/now', text: '[main]\nThe road' }) });
  k.hear('before');
  await k.clock.advance(1000);
  await k.tapFlag();
  const [f] = logged(k, 'trace.flag');
  assert.equal(f.data.at, k.clock.now());
  assert.equal(f.data.screen, undefined, 'the copy is its own entry');
  assert.equal(f.data.route, '#/now');
  assert.equal(f.data.lastClip, 'before');
  assert.equal(f.scope, 'sys:device');
  const [copy] = logged(k, 'trace.screen');
  assert.equal(copy.data.text, '[main]\nThe road');
  assert.equal(copy.data.flag, f.data.at);
  assert.deepEqual(k.toasts, ['Flagged']);
  k.hear('in');
  await k.clock.advance(FLAG_MS);
  k.hear('edge');
  await k.clock.advance(1);
  k.hear('out');
  await settle();
  assert.deepEqual(logged(k, 'trace.clip').map((/** @type {any} */ e) => [e.data.id, e.data.flag]), [['before', undefined], ['in', f.data.at], ['edge', f.data.at], ['out', undefined]]);
  await k.clock.advance(BATCH_MS);
  const sent = k.posts.filter((/** @type {any} */ x) => x.url === SERVER).flatMap((/** @type {any} */ x) => x.body.entries).map((/** @type {any} */ e) => e.type);
  assert.ok(sent.includes('trace.flag') && sent.includes('trace.screen'), 'both reach the server');
  k.stop();
});

test('a route change copies the screen once it has drawn, once for a burst of changes; a long screen is cut', async () => {
  const k = await kit({ settings: ON, screen: () => ({ route: '#/plan', text: 'x'.repeat(SCREEN_CHARS + 5) }) });
  k.route();
  k.route();
  await k.clock.advance(SCREEN_SETTLE_MS - 1);
  assert.equal(logged(k, 'trace.screen').length, 0);
  await k.clock.advance(1);
  const copies = logged(k, 'trace.screen');
  assert.equal(copies.length, 1);
  assert.equal(copies[0].data.route, '#/plan');
  assert.equal(copies[0].data.text.length, SCREEN_CHARS);
  assert.equal(copies[0].data.cut, true);
  k.stop();
});

test('keys never appear in a screen copy: any secret annai keeps, or anything shaped like one, is blanked before it is even logged here', async () => {
  const KEPT = 'sk-kept-provider-key-0123456789';
  const k = await kit({ settings: ON, secrets: { 'model:one': KEPT }, screen: () => ({ route: '#/models', text: `Key: ${KEPT}\nAuthorization: Bearer abcdefghijklmnop0123456789\nserver ${TOKEN}` }) });
  await k.tapFlag();
  const all = JSON.stringify(k.appended);
  assert.equal(logged(k, 'trace.flag').length, 1);
  assert.equal(all.includes(KEPT), false);
  assert.equal(all.includes(TOKEN), false);
  assert.equal(all.includes('abcdefghijklmnop0123456789'), false);
  k.stop();
});

test('when the secrets can\'t be read nothing is copied, and the toast says the flag failed', async () => {
  const k = await kit({ settings: ON });
  k.store.tx = async () => { throw new Error('the database closed'); };
  await k.tapFlag();
  assert.equal(k.appended.length, 0);
  assert.deepEqual(k.toasts, ['Not flagged']);
  k.stop();
});

/** A little DOM, enough for screenText. @param {string} tagName @param {Record<string, string>} attrs @param {...any} kids */
const el = (tagName, attrs = {}, ...kids) => ({
  nodeType: 1, tagName, childNodes: kids.map((c) => (typeof c === 'string' ? { nodeType: 3, nodeValue: c } : c)),
  hasAttribute: (/** @type {string} */ a) => a in attrs, getAttribute: (/** @type {string} */ a) => attrs[a] ?? null, style: attrs,
});

test('a screen copy is the visible text with its landmarks, and nothing from a field', () => {
  const KEY = 'sk-typed-into-a-field-0123456789';
  const root = el('BODY', {},
    el('HEADER', {}, ' Big   Sur '),
    el('MAIN', {},
      el('P', {}, 'Your key'),
      Object.assign(el('INPUT', { type: 'password', value: KEY }), { value: KEY }),
      el('TEXTAREA', {}, KEY),
      el('SELECT', {}, el('OPTION', {}, KEY)),
      el('DIV', { contenteditable: 'true' }, KEY),
      el('SCRIPT', {}, KEY),
      el('P', { display: 'none' }, 'folded away'),
      el('P', { off: 'yes' }, 'scrolled away'),
      el('SECTION', { 'aria-label': 'Today' }, 'Lunch'),
      el('SECTION', {}, 'Dinner')),
    el('NAV', { 'aria-label': 'Tabs', off: 'yes' }, 'not seen'),
    el('DIV', { role: 'dialog' }, 'Sure?'));
  const text = screenText(root, { gone: (/** @type {any} */ n) => n.style.display === 'none', seen: (/** @type {any} */ n) => n.style.off !== 'yes' });
  assert.equal(text, '[header]\nBig Sur\n[main]\nYour key\n[section: Today]\nLunch\nDinner\n[dialog]\nSure?');
  assert.equal(text.includes(KEY), false);
});

// Fix pass 1 (findings from the review of Detailed trace).
/** What reached the server's batch address, by entry type. @param {any} k */
const sentTypes = (k) => k.posts.filter((/** @type {any} */ x) => x.url === SERVER).flatMap((/** @type {any} */ x) => x.body.entries).map((/** @type {any} */ e) => e.type).filter((/** @type {string} */ t) => t !== 'file.write');

test('screen text that waited offline does not leave after Detailed trace goes off: the flag and the copy go with what waits', async () => {
  const k = await kit({ settings: ON, online: false, screen: () => ({ route: '#/now', text: 'Dinner at eight' }) });
  k.give(entry(1));
  k.hear('a');
  await k.tapFlag();
  k.route();
  await k.clock.advance(SCREEN_SETTLE_MS);
  assert.ok(logged(k, 'trace.screen').length >= 2 && logged(k, 'trace.flag').length === 1);
  await k.save({ detailed: false });
  await k.goOnline();
  await k.clock.advance(RETRY_MAX_MS);
  const types = sentTypes(k);
  assert.deepEqual(types, ['msg.user'], 'only the ordinary entry goes');
  assert.equal(JSON.stringify(k.posts).includes('Dinner at eight'), false);
  k.stop();
});

test('a batch on its way when Detailed trace goes off, and refused, comes back without its trace entries', async () => {
  let release = () => {};
  const held = new Promise((r) => { release = () => r(null); });
  const k = await kit({ settings: ON, screen: () => ({ route: '#/now', text: 'Dinner at eight' }), answer: async (_n, init) => { if (typeof init.body === 'string') { await held; return new Response('{}', { status: 503 }); } return new Response('{}'); } });
  await k.tapFlag();
  k.give(entry(1));
  await k.clock.advance(BATCH_MS);
  assert.equal(k.posts.filter((p) => p.url === SERVER).length, 1, 'the batch is on its way');
  await k.save({ detailed: false });
  release();
  await k.clock.advance(RETRY_MAX_MS * 2);
  const later = k.posts.filter((p) => p.url === SERVER).slice(1).flatMap((p) => p.body.entries.map((/** @type {any} */ e) => e.type));
  assert.deepEqual([...new Set(later)].filter((t) => t !== 'file.write'), ['msg.user']);
  k.stop();
});

test('a different server turns Detailed trace off: clips waiting and the one on its way do not go to the new address, and the switch is saved off', async () => {
  const k = await kit({ settings: ON, answer: () => new Promise(() => {}) });
  k.hear('a');
  k.hear('b');
  await k.clock.advance(0);
  assert.equal(clipPosts(k).length, 1);
  const flight = clipPosts(k)[0].init.signal;
  await k.save({ server: 'https://other.example/trace' });
  assert.equal(flight.aborted, true, 'the clip on its way is cut off');
  assert.equal(k.tapped.size, 0);
  assert.equal(k.chips.has('flag'), false);
  assert.equal(k.saved.detailed, false);
  assert.equal(k.saved.detailedUntil, null);
  assert.equal(k.cards.at(-1).title, 'Detailed trace turned off');
  await k.clock.advance(RETRY_MAX_MS);
  assert.equal(k.posts.filter((p) => p.url.startsWith('https://other.example')).filter((p) => new URL(p.url).pathname.endsWith('/clips')).length, 0);
  k.stop();
});

test('the same server saved again keeps Detailed trace on, and its address is compared as written without spaces', async () => {
  const k = await kit({ settings: ON });
  await k.save({ server: ` ${SERVER} ` });
  assert.equal(k.tapped.size, 1);
  assert.equal(k.saved.detailed, true);
  k.stop();
});

test('a screen copy leaves out what is inside a closed <details>, and keeps its summary; an open one is read', () => {
  const closed = el('DETAILS', {}, el('SUMMARY', {}, 'net.request'), el('PRE', {}, '{"url":"https://example.test/forecast?lat=1"}'));
  const open = el('DETAILS', { open: '' }, el('SUMMARY', {}, 'Row'), el('PRE', {}, 'its json'));
  const text = screenText(el('BODY', {}, closed, open), { gone: () => false, seen: () => true });
  assert.equal(text, 'net.request\nRow\nits json');
});

test('on the Trace screen no text is copied, only the route: not by a route change, not by Flag', async () => {
  const k = await kit({ settings: ON, screen: () => ({ route: '#/trace', text: 'open row {"lat":1}' }) });
  k.route();
  await k.clock.advance(SCREEN_SETTLE_MS);
  await k.tapFlag();
  const copies = logged(k, 'trace.screen');
  assert.equal(copies.length, 2);
  for (const c of copies) assert.deepEqual([c.data.route, c.data.text], ['#/trace', '']);
  assert.equal(JSON.stringify(k.appended).includes('lat'), false);
  k.stop();
  const filtered = await kit({ settings: ON, screen: () => ({ route: '#/trace?type=net', text: 'x' }) });
  await filtered.tapFlag();
  assert.equal(logged(filtered, 'trace.screen')[0].data.text, '');
  const other = await kit({ settings: ON, screen: () => ({ route: '#/traces-of-snow', text: 'kept' }) });
  await other.tapFlag();
  assert.equal(logged(other, 'trace.screen')[0].data.text, 'kept', 'only the Trace screen');
  filtered.stop();
  other.stop();
});

test('a line that looks like a key by its prefix (sk-ant-, AIza, ghp_) is left out of the screen copy even when annai keeps no such key', () => {
  const root = el('BODY', {}, el('P', {}, 'Paste sk-ant-api03-abcdefghijklmnop here'), el('P', {}, 'AIzaSyA1234567890abcdefghij'), el('P', {}, 'ghp_abcdefghijklmnopqrstuvwxyz0123'),
    el('P', {}, 'The ghp_ prefix, and sk-ant- alone, are words'), el('P', {}, 'Lunch'));
  assert.equal(screenText(root, { gone: () => false, seen: () => true }), 'The ghp_ prefix, and sk-ant- alone, are words\nLunch');
});

test('Detailed trace ends 24 hours after it began even when the saved end is later: a clock set ahead cannot lengthen it', async () => {
  const k = await kit({ settings: { ...ON, detailedUntil: T0 + 10 * DETAIL_MS, detailedFor: SERVER } });
  assert.equal(k.saved.detailedUntil, T0 + DETAIL_MS);
  await k.clock.advance(DETAIL_MS);
  assert.equal(k.tapped.size, 0);
  k.stop();
});

test('text is judged by where it is, not by where its parent is: a line scrolled out of a tall block is left out', () => {
  const a = { nodeType: 3, nodeValue: 'in view', out: false };
  const b = { nodeType: 3, nodeValue: 'scrolled away', out: true };
  const root = el('BODY', {}, el('DIV', {}, a, b));
  const text = screenText(root, { gone: () => false, seen: (/** @type {any} */ _el, /** @type {any} */ node) => !node.out });
  assert.equal(text, 'in view');
});

test('Flag takes the Trace chip\'s place while Detailed trace is on, so the dock\'s row is no wider; the Trace chip is back when it goes off', async () => {
  const k = await kit({ settings: { server: SERVER, send: true } });
  assert.deepEqual([...k.chips.keys()], ['sending']);
  await k.save({ detailed: true });
  assert.deepEqual([...k.chips.keys()], ['flag']);
  await k.save({ detailed: false });
  assert.deepEqual([...k.chips.keys()], ['sending']);
  await k.save({ detailed: true });
  await k.clock.advance(DETAIL_MS);
  assert.deepEqual([...k.chips.keys()], ['sending'], 'back when it turns itself off');
  await k.save({ detailed: true });
  await k.save({ send: false });
  assert.deepEqual([...k.chips.keys()], [], 'Send off: no chip at all');
  k.stop();
});

// Fix pass 2 (findings from the re-review).
/** The entry types of every batch that went to the server's batch address, in order. @param {any} k */
const batchTypes = (k) => k.posts.filter((/** @type {any} */ x) => x.url === SERVER).map((/** @type {any} */ x) => x.body.entries.map((/** @type {any} */ e) => e.type));

test('Detailed trace off while a batch holding screen text is on its way: that request is cut off, and its ordinary entries go again without it', async () => {
  const k = await kit({ settings: ON, screen: () => ({ route: '#/now', text: 'Dinner at eight' }), answer: (n) => (n === 1 ? new Promise(() => {}) : new Response('{}')) });
  await k.tapFlag();
  k.give(entry(1));
  await k.clock.advance(BATCH_MS);
  assert.equal(k.posts.filter((p) => p.url === SERVER).length, 1, 'the batch is on its way');
  assert.ok(batchTypes(k)[0].includes('trace.screen'));
  await k.save({ detailed: false });
  assert.equal(k.posts[0].init.signal.aborted, true, 'the request holding screen text is cut off');
  await k.clock.advance(RETRY_MAX_MS);
  const later = batchTypes(k).slice(1).flat();
  assert.ok(later.includes('msg.user'), 'the ordinary entry still goes');
  assert.equal(later.some((t) => t.startsWith('trace.')), false);
  assert.equal(JSON.stringify(k.posts.slice(1)).includes('Dinner at eight'), false);
  k.stop();
});

test('Detailed trace off while a batch is still getting its token and its blanking: it does not post, and what goes later has no trace entries', async () => {
  const k = await kit({ settings: ON, screen: () => ({ route: '#/now', text: 'Dinner at eight' }) });
  await k.tapFlag();
  k.give(entry(1));
  let release = () => {};
  const held = new Promise((r) => { release = () => r(null); });
  const real = k.store.tx;
  k.store.tx = /** @type {any} */ ((/** @type {any[]} */ ...a) => held.then(() => real.apply(k.store, /** @type {any} */ (a))));
  await k.clock.advance(BATCH_MS);
  assert.equal(k.posts.length, 0, 'the batch is waiting for its token');
  await k.save({ detailed: false });
  k.store.tx = real;
  release();
  await k.clock.advance(RETRY_MAX_MS);
  const sent = batchTypes(k).flat();
  assert.ok(sent.includes('msg.user'));
  assert.equal(sent.some((t) => t.startsWith('trace.')), false);
  assert.equal(JSON.stringify(k.posts).includes('Dinner at eight'), false);
  k.stop();
});

test('a phone asleep past the end of Detailed trace, with a retry of a batch due: the retry finds it over, and screen text does not go', async () => {
  const k = await kit({ settings: ON, screen: () => ({ route: '#/now', text: 'Dinner at eight' }), answer: (n) => (n === 1 ? new Response('{}', { status: 503 }) : new Response('{}')) });
  await k.tapFlag();
  k.give(entry(1));
  await k.clock.advance(BATCH_MS);
  assert.equal(batchTypes(k).length, 1, 'the first try was refused, and a retry is due');
  k.clock.jump(DETAIL_MS);
  await k.clock.advance(0);
  const later = batchTypes(k).slice(1).flat();
  assert.ok(later.includes('msg.user'));
  assert.equal(later.some((t) => t.startsWith('trace.')), false);
  assert.equal(k.saved.detailed, false);
  k.stop();
});

test('a different address saved while it was not running turns Detailed trace off when it comes back: no Flag, no screen copy, the switch saved off, one card', async () => {
  const first = await kit({ settings: ON });
  assert.equal(first.saved.detailedFor, SERVER);
  first.stop();
  const again = await kit({ settings: { ...first.saved, server: 'https://other.example/trace' }, screen: () => ({ route: '#/now', text: 'Dinner at eight' }) });
  assert.equal(again.tapped.size, 0);
  assert.equal(again.chips.has('flag'), false);
  assert.equal(again.saved.detailed, false);
  assert.equal(again.saved.detailedUntil, null);
  assert.equal(again.cards.length, 1);
  assert.equal(again.cards[0].title, 'Detailed trace turned off');
  again.route();
  await again.clock.advance(RETRY_MAX_MS);
  assert.equal(again.appended.length, 0);
  assert.equal(JSON.stringify(again.posts).includes('Dinner at eight'), false);
  again.stop();
  // Turned on afresh for the new address, it starts, and is tied to that address.
  const fresh = await kit({ settings: { server: 'https://other.example/trace', send: true, detailed: true } });
  assert.equal(fresh.tapped.size, 1);
  assert.equal(fresh.saved.detailedFor, 'https://other.example/trace');
  fresh.stop();
});

test('rows of the Trace screen are left out by the element, so they stay out while the old screen is still drawn under a new route', () => {
  const rows = el('OL', { class: 'trace' }, el('LI', {}, el('DETAILS', { open: '' }, el('SUMMARY', {}, 'net.request'), el('PRE', {}, '{"url":"https://example.test/forecast?lat=1"}'))));
  const text = screenText(el('BODY', {}, el('MAIN', {}, el('H1', {}, 'Trace'), rows), el('OL', { class: 'steps' }, el('LI', {}, 'Lunch'))), { gone: () => false, seen: () => true });
  assert.equal(text, '[main]\nTrace\nLunch');
});
