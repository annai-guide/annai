/* annai service worker: offline app shell, installed plugin files, Android share target (spec §3). */
const VERSION = '0.1.0';
// A hash of the SHELL files, written by scripts/stamp.mjs: any change to them makes a new cache.
const BUILD = '55cad70a2403';
const CACHE = `annai-shell-${VERSION}-${BUILD}`;
const INBOX = 'annai-inbox';
const PUSH_NEWS = 'annai-push';
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
const DEV = ['localhost', '127.0.0.1'].includes(sw.location.hostname);
// The languages with a catalog (written by strings.mjs); stamp.mjs hashes the catalogs after SHELL.
const LANGS = ['ja', 'zh-Hans'];
// The finished ones: a phone is matched against these only; a user's own choice may be any of LANGS.
const SHIPPED_LANGS = ['ja', 'zh-Hans'];
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/LICENSE',
  '/assets/fonts/OFL.txt',
  '/assets/fonts/ibm-plex-mono-400.woff2',
  '/assets/fonts/ibm-plex-mono-500.woff2',
  '/assets/fonts/zen-kaku-gothic-new-400.woff2',
  '/assets/fonts/zen-kaku-gothic-new-500.woff2',
  '/assets/fonts/zen-kaku-gothic-new-700.woff2',
  '/assets/fonts/zen-maru-gothic-500.woff2',
  '/assets/fonts/zen-maru-gothic-700.woff2',
  '/assets/icons/apple-touch-icon.png',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-maskable-512.png',
  '/assets/personalities/quiet.md',
  '/assets/personalities/shiori.md',
  '/assets/personalities/storyteller.md',
  '/assets/shiori.svg',
  '/assets/simulations/big-sur.json',
  '/skills/driving-companion/SKILL.md',
  '/skills/plan-a-trip/SKILL.md',
  '/skills/replanning/SKILL.md',
  '/src/app/boot.js',
  '/src/app/claim.js',
  '/src/app/main.js',
  '/src/app/version.js',
  '/src/core/after/journey.js',
  '/src/core/after/recap.js',
  '/src/core/after/replay.js',
  '/src/core/after/route.js',
  '/src/core/after/stamps.js',
  '/src/core/archive-crypto.js',
  '/src/core/agent/blocks.js',
  '/src/core/agent/budgets.js',
  '/src/core/agent/compaction.js',
  '/src/core/agent/context.js',
  '/src/core/agent/halves.js',
  '/src/core/agent/instructions.js',
  '/src/core/agent/listen.js',
  '/src/core/agent/log.js',
  '/src/core/agent/loop.js',
  '/src/core/agent/personalities.js',
  '/src/core/agent/refusals.js',
  '/src/core/agent/self-tools.js',
  '/src/core/agent/net.js',
  '/src/core/agent/tools.js',
  '/src/core/agent/transcript.js',
  '/src/core/agent/via.js',
  '/src/core/agent/warmth.js',
  '/src/core/address.js',
  '/src/core/answer.js',
  '/src/core/archive.js',
  '/src/core/backup.js',
  '/src/core/backup-auto.js',
  '/src/core/backup-targets.js',
  '/src/core/bookings.js',
  '/src/core/bytes.js',
  '/src/core/catalog-facts.js',
  '/src/core/crc32.js',
  '/src/core/errors.js',
  '/src/core/events.js',
  '/src/core/forget.js',
  '/src/core/hash.js',
  '/src/core/hooks.js',
  '/src/core/html-text.js',
  '/src/core/llm/call.js',
  '/src/core/llm/check.js',
  '/src/core/llm/config.js',
  '/src/core/llm/contract.js',
  '/src/core/llm/decide.js',
  '/src/core/llm/fallback.js',
  '/src/core/llm/move-over.js',
  '/src/core/llm/official.js',
  '/src/core/llm/provider-desc.js',
  '/src/core/llm/providers.js',
  '/src/core/llm/setup.js',
  '/src/core/llm/cost.js',
  '/src/core/llm/partial-json.js',
  '/src/core/llm/reasoning.js',
  '/src/core/llm/retry.js',
  '/src/core/llm/service.js',
  '/src/core/llm/speech.js',
  '/src/core/llm/sse.js',
  '/src/core/llm/trace.js',
  '/src/core/llm/uploads.js',
  '/src/core/llm/kept.js',
  '/src/core/live/activity.js',
  '/src/core/live/clock.js',
  '/src/core/live/geo.js',
  '/src/core/live/live.js',
  '/src/core/live/plan-watches.js',
  '/src/core/live/sim-run.js',
  '/src/core/live/simulate.js',
  '/src/core/live/triggers.js',
  '/src/core/live/watch-tools.js',
  '/src/core/live/watches.js',
  '/src/core/ics.js',
  '/src/core/imports.js',
  '/src/core/inflate.js',
  '/src/core/intl.js',
  '/src/core/koe/context.js',
  '/src/core/koe/instructions.js',
  '/src/core/koe/live.js',
  '/src/core/koe/tools.js',
  '/src/core/l10n-list.js',
  '/src/core/l10n.js',
  '/src/core/languages.js',
  '/src/core/links.js',
  '/src/core/lock.js',
  '/src/core/now.js',
  '/src/core/official-names.js',
  '/src/core/package-updates.js',
  '/src/core/packages.js',
  '/src/core/requires.js',
  '/src/core/pack/download.js',
  '/src/core/pack/keeper.js',
  '/src/core/pack/osm.js',
  '/src/core/pack/plan.js',
  '/src/core/pack/read.js',
  '/src/core/patch.js',
  '/src/core/photo-meta.js',
  '/src/core/pkpass.js',
  '/src/core/photos.js',
  '/src/core/nominatim.js',
  '/src/core/paths.js',
  '/src/core/plan.js',
  '/src/core/plugins.js',
  '/src/core/push/mirror.js',
  '/src/core/push/relay-client.js',
  '/src/core/push/webpush.js',
  '/src/core/reach.js',
  '/src/core/realtime/input.js',
  '/src/core/realtime/open.js',
  '/src/core/registry.js',
  '/src/core/request-photos.js',
  '/src/core/schema.js',
  '/src/core/search.js',
  '/src/core/scopes.js',
  '/src/core/settings.js',
  '/src/core/shown.js',
  '/src/core/signals.js',
  '/src/core/skills.js',
  '/src/core/store-idb.js',
  '/src/core/storage-types.js',
  '/src/core/store-memory.js',
  '/src/core/sun.js',
  '/src/core/time.js',
  '/src/core/xml.js',
  '/src/core/tsv.js',
  '/src/core/voice/detector.js',
  '/src/core/voice/formats.js',
  '/src/core/voice/g711.js',
  '/src/core/voice/gate.js',
  '/src/core/voice/listening.js',
  '/src/core/voice/mic.js',
  '/src/core/voice/mode.js',
  '/src/core/voice/mux.js',
  '/src/core/voice/pcm.js',
  '/src/core/voice/platform.js',
  '/src/core/voice/recorder.js',
  '/src/core/voice/resolve.js',
  '/src/core/voice/sentences.js',
  '/src/core/voice/settings.js',
  '/src/core/voice/speaker.js',
  '/src/core/voice/stream-start.js',
  '/src/core/voice/voice.js',
  '/src/core/voice/where.js',
  '/src/core/types.js',
  '/src/core/ui-slots.js',
  '/src/core/web-search.js',
  '/src/core/workspace.js',
  '/src/core/zip.js',
  '/src/plugins/core-schemas/index.js',
  '/src/plugins/core-schemas/schemas.js',
  '/src/plugins/files/index.js',
  '/src/plugins/go/index.js',
  '/src/plugins/mcp/client.js',
  '/src/plugins/mcp/index.js',
  '/src/plugins/places/index.js',
  '/src/plugins/sensors/index.js',
  '/src/plugins/skills/index.js',
  '/src/plugins/voice-browser/capture-worklet.js',
  '/src/plugins/voice-browser/player-worklet.js',
  '/src/plugins/voice-browser/index.js',
  '/src/plugins/web/free.js',
  '/src/plugins/web/index.js',
  '/src/ui/base.css',
  '/src/ui/cards.js',
  '/src/ui/credits.js',
  '/src/ui/dock.js',
  '/src/ui/dom.js',
  '/src/ui/add-files.js',
  '/src/ui/auto-backup.js',
  '/src/ui/ask.js',
  '/src/ui/avatar.js',
  '/src/ui/bring-in.js',
  '/src/ui/export-panel.js',
  '/src/ui/format.js',
  '/src/ui/grounding.html',
  '/src/ui/grounding.js',
  '/src/ui/import-state.js',
  '/src/ui/install.js',
  '/src/ui/languages.js',
  '/src/ui/live-chip.js',
  '/src/ui/live-help.js',
  '/src/ui/markdown.js',
  '/src/ui/media-keys.js',
  '/src/ui/mic-help.js',
  '/src/ui/model-check.js',
  '/src/ui/notices.js',
  '/src/ui/offline-pack.js',
  '/src/ui/open-file.js',
  '/src/ui/photo-codec.js',
  '/src/ui/photo-viewer.js',
  '/src/ui/platform.js',
  '/src/ui/privacy.js',
  '/src/ui/plugin-cards.js',
  '/src/ui/plugin-pending.js',
  '/src/ui/provider-setup.js',
  '/src/ui/plugin-updates.js',
  '/src/ui/push.js',
  '/src/ui/resume.js',
  '/src/ui/router.js',
  '/src/ui/save.js',
  '/src/ui/settings-form.js',
  '/src/ui/screens/about.js',
  '/src/ui/screens/add.js',
  '/src/ui/screens/backups.js',
  '/src/ui/screens/booking.js',
  '/src/ui/screens/drive.js',
  '/src/ui/screens/experimental.js',
  '/src/ui/screens/ext.js',
  '/src/ui/screens/file.js',
  '/src/ui/screens/import.js',
  '/src/ui/screens/mcp.js',
  '/src/ui/screens/model.js',
  '/src/ui/screens/models.js',
  '/src/ui/screens/notifications.js',
  '/src/ui/screens/now.js',
  '/src/ui/screens/plan.js',
  '/src/ui/screens/plugin-install.js',
  '/src/ui/screens/plugin.js',
  '/src/ui/screens/plugins.js',
  '/src/ui/screens/provider.js',
  '/src/ui/screens/recap.js',
  '/src/ui/screens/replay.js',
  '/src/ui/screens/settings.js',
  '/src/ui/screens/simulate.js',
  '/src/ui/screens/shiori.js',
  '/src/ui/screens/talk.js',
  '/src/ui/screens/tools.js',
  '/src/ui/screens/trace.js',
  '/src/ui/screens/trip.js',
  '/src/ui/screens/trips.js',
  '/src/ui/screens/updates.js',
  '/src/ui/screens/voice.js',
  '/src/ui/screens/welcome.js',
  '/src/ui/search-panel.js',
  '/src/ui/shell.js',
  '/src/ui/slots.js',
  '/src/ui/stamps.js',
  '/src/ui/shiori.css',
  '/src/ui/speech-check.js',
  '/src/ui/storage-full.js',
  '/src/ui/talk-panel.js',
  '/src/ui/tap-keeps-keyboard.js',
  '/src/ui/dock-hides.js',
  '/src/ui/trip-rows.js',
  '/src/ui/tokens.css',
  '/src/ui/unlock.js',
  '/src/ui/updates.js',
  '/src/ui/voice-chip.js',
  '/src/ui/wake-lock.js',
  '/src/ui/welcome.js',
];

sw.addEventListener('install', (event) => {
  // The shell and the screens' words, as one: a version whose words can't be fetched isn't installed. Past the HTTP cache. A shell
  // file an older version holds unchanged is copied from it instead.
  event.waitUntil((async () => {
    const words = (await wordsToCache()).map(wordsPath);
    const cache = await caches.open(CACHE);
    const copies = await unchanged(words);
    // The record goes first and comes back last, so a cache cut off part-way has none.
    await cache.delete(RECORD);
    await cache.addAll([...SHELL, ...words].filter((p) => !copies.has(p)).map((u) => new Request(u, { cache: 'reload' })));
    for (const path of words) {
      const copy = copies.get(path);
      if (copy?.res) await cache.put(path, copy.res);
    }
    /** @type {Record<string, string>} */
    const files = {};
    for (const path of SHELL) {
      const copy = copies.get(path);
      if (copy?.res) await cache.put(path, copy.res);
      // A fetched file is recorded as it came: one that changed mid-release is fetched again next time.
      const res = copy ? null : await cache.match(path);
      const hash = copy?.hash ?? (res && await hashOf(res));
      if (hash) files[path] = hash;
    }
    await cache.put(RECORD, new Response(JSON.stringify({ files })));
    // A waiting version brought in meanwhile (Restart now) deletes this cache as it activates: this version would start on none.
    if (!(await caches.match(RECORD, { cacheName: CACHE }))) throw new Error("this version's cache was deleted while it installed");
  })());
});

/** Where a shell cache records the hash of each shell file it holds: { files: { path: hash } }. */
const RECORD = '/shell-record.json';
/** A file's hash, as stamp.mjs writes them in shell.json ({ build, files: { path: hash } }): 12 hex digits of its SHA-256. @param {Response} res */
async function hashOf(res) {
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', await res.arrayBuffer()));
  return [...sum].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/**
 * The shell files the newest shell cache with a readable record holds under this build's hash, and the catalogs (words) it holds
 * unchanged (res: null when that cache is this build's own). None when there is no such cache (a first install), or this build's manifest can't be had. Never a page: its
 * headers carry the site's policy (CSP, Permissions-Policy), and a release may change that alone.
 * @returns {Promise<Map<string, { res: Response | null, hash: string }>>}
 */
async function unchanged(words = /** @type {string[]} */ ([])) {
  const copies = new Map();
  for (const name of (await caches.keys()).reverse()) {
    if (!name.startsWith('annai-shell-')) continue;
    const old = await caches.open(name);
    const had = filesOf(await (await old.match(RECORD))?.json().catch(() => null));
    if (!had) continue;
    const res = await fetch(new Request('/shell.json', { cache: 'reload' })).catch(() => null);
    const manifest = res?.ok ? await res.json().catch(() => null) : null;
    const want = manifest?.build === BUILD ? filesOf(manifest) : null;
    for (const path of want ? SHELL.filter((p) => !/(?:\/|\.html)$/.test(p)) : []) {
      const hash = want?.[path];
      const kept = typeof hash === 'string' && had[path] === hash ? await old.match(path) : null;
      if (kept) copies.set(path, { res: name === CACHE ? null : kept, hash });
    }
    // A catalog by its own bytes' hash: words kept since (cache-words) are in no record.
    for (const path of want ? words : []) {
      const hash = want?.[path];
      const kept = typeof hash === 'string' ? await old.match(path) : null;
      if (kept && (await hashOf(kept.clone())) === hash) copies.set(path, { res: name === CACHE ? null : new Response(await kept.arrayBuffer(), { headers: { 'Content-Type': 'application/json' } }), hash });
    }
    break;
  }
  return copies;
}

/** The files of a record or a manifest, or null when it isn't one. @param {any} parsed @returns {Record<string, unknown> | null} */
function filesOf(parsed) {
  const files = parsed?.files;
  return files && typeof files === 'object' && !Array.isArray(files) ? files : null;
}

/** @param {string} tag */
const wordsPath = (tag) => `/l10n/${tag}.json`;

/** Whether two tags are one language and script (zh-TW is zh-Hant, not zh-Hans). @param {string} a @param {string} b */
function sameLanguage(a, b) {
  try {
    const [x, y] = [new Intl.Locale(a).maximize(), new Intl.Locale(b).maximize()];
    return x.language === y.language && x.script === y.script;
  } catch {
    return false;
  }
}

/**
 * The languages whose catalogs a version caches: languages.ui in the app settings, else the worker's own languages against the shipped
 * ones; none: English. When the settings can't be read in time, also each one an older version holds, so a chosen one isn't lost
 * when activate drops the old cache. @returns {Promise<string[]>}
 */
async function wordsToCache() {
  // An open queued behind a blocked upgrade or delete never answers, and no update may wait for it: after 3 s the phone decides.
  const late = {};
  const app = await Promise.race([readJson('sys:settings', '/app.json'), new Promise((resolve) => setTimeout(() => resolve(late), 3000))]);
  const chosen = chosenWords(app === late ? null : app);
  const tags = chosen ? [chosen] : [];
  if (app !== late) return tags;
  for (const name of await caches.keys()) {
    if (!name.startsWith('annai-shell-') || name === CACHE) continue;
    const old = await caches.open(name);
    for (const tag of LANGS) if (!tags.includes(tag) && await old.match(wordsPath(tag))) tags.push(tag);
  }
  return tags;
}

/** The language the settings choose, else the first of the phone's that annai ships, English among them, as the page's start does; null: English. @param {any} app */
function chosenWords(app) {
  const ui = app?.languages?.ui;
  if (ui === 'en') return null;
  if (typeof ui === 'string' && LANGS.includes(ui)) return ui;
  for (const wanted of sw.navigator?.languages ?? []) {
    const found = ['en', ...SHIPPED_LANGS].find((tag) => sameLanguage(wanted, tag));
    if (found) return found === 'en' ? null : found;
  }
  return null;
}

/**
 * Keeps a language's words in every shell cache (a waiting version's too), and answers on the port. Offline, words already on the
 * device do. @param {unknown} tag @param {MessagePort | undefined} port
 */
async function cacheWords(tag, port) {
  let ok = false;
  try {
    if (typeof tag !== 'string' || !LANGS.includes(tag)) throw new Error('not a language annai has');
    let res = await fetch(new Request(wordsPath(tag), { cache: 'reload' })).catch(() => null);
    const device = !(await isCatalog(res));
    if (device) res = (await (await caches.open(CACHE)).match(wordsPath(tag))) ?? null;
    if (!res || !(await isCatalog(res))) throw new Error('not a catalog');
    for (const name of await caches.keys()) {
      if (!name.startsWith('annai-shell-')) continue;
      const cache = await caches.open(name);
      // The device's words never cover a catalog a cache has: a waiting version's may be newer. Where they go, they are marked, so
      // that version fetches its own once it is online (respond).
      if (!device) await cache.put(wordsPath(tag), res.clone());
      else if (!(await cache.match(wordsPath(tag)))) await cache.put(wordsPath(tag), new Response(await res.clone().text(), { headers: { 'Content-Type': 'application/json', [FROM_DEVICE]: 'device' } }));
    }
    ok = true;
  } catch { /* said no below */ }
  port?.postMessage({ ok });
}

/** The header on words a version took from an older one's cache, offline: they are fetched fresh once there is a connection. */
const FROM_DEVICE = 'x-annai-words';

/** Whether a response is a catalog: a JSON object (a captive portal answers 200 with its own page). @param {Response | null | undefined} res */
async function isCatalog(res) {
  try {
    const words = res?.ok ? await res.clone().json() : null;
    return Boolean(words) && typeof words === 'object' && !Array.isArray(words);
  } catch {
    return false;
  }
}

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('annai-shell-') && key !== CACHE) await caches.delete(key);
    await sw.clients.claim();
  })());
});

// A new version waits until annai restarts; it only takes over early when the user taps "Restart now" (spec §17 rule 5).
// Settings → About asks which build is running, on a port of its own. A page loaded past this worker asks to be taken.
sw.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') sw.skipWaiting();
  else if (event.data === 'build') event.ports?.[0]?.postMessage({ version: VERSION, build: BUILD });
  else if (event.data === 'claim') event.waitUntil(sw.clients.claim().catch(() => {}));
  else if (event.data?.type === 'cache-words') event.waitUntil(cacheWords(event.data.tag, event.ports?.[0]));
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith('/plugins/')) {
    event.respondWith(servePlugin(req, url.pathname));
    return;
  }
  if (url.pathname === '/share-target' && req.method === 'POST') {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET' || url.pathname.startsWith('/test/')) return;
  // Every page is the app, but the frame Google's search suggestions are drawn in: a page of its own, with its own policy (G4).
  event.respondWith(respond(req, req.mode === 'navigate' && url.pathname !== '/src/ui/grounding.html' ? '/index.html' : null, (p) => event.waitUntil(p)));
});

/** Production: cache first. Development (localhost): network first, so edits show up. A catalog that comes from the network is kept for the next start offline.
 * @param {Request} req @param {string | null} fallback @param {(p: Promise<unknown>) => unknown} [later] work that goes on after the answer
 */
async function respond(req, fallback, later = (p) => p) {
  const cache = await caches.open(CACHE);
  const cached = () => cache.match(fallback ?? req, { ignoreSearch: true });
  const tag = LANGS.find((l) => new URL(req.url).pathname === wordsPath(l));
  const fetched = async () => {
    const res = await fetch(req);
    if (!tag) return res;
    // Words are kept only when they are a catalog; else the words kept here answer, if there are any.
    if (!(await isCatalog(res))) return (await cached()) ?? res;
    await cache.put(wordsPath(tag), res.clone()).catch(() => {});
    return res;
  };
  if (DEV) {
    try {
      return await fetched();
    } catch {
      return (await cached()) ?? Response.error();
    }
  }
  const hit = await cached();
  // Words marked as an older version's: served at once, and this version's own fetched in the background, once.
  if (tag && hit?.headers.get(FROM_DEVICE)) later(fetched().catch(() => {}));
  return hit ?? fetched();
}

/** Opens the app's database without ever creating it from here. @returns {Promise<IDBDatabase>} */
function openExisting() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('annai');
    r.onupgradeneeded = () => r.transaction?.abort();
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close(); // never hold up the app's upgrade
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
  });
}

/** Plugin files a page may load: code, data, styles, plain text, raster images and fonts. Never HTML or SVG. */
const SAFE_PLUGIN_TYPES = new Set(['text/javascript', 'application/json', 'text/css', 'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'font/woff2']);

/** @param {string} why */
function deny(why) {
  return new Response(why, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
}

/**
 * Serves /plugins/<id>/<file> from the sys:plugins scope, but only for an installed plugin
 * that is switched on, only as a safe type, and never as a page: a stored package must not
 * become a same-origin page that runs before the user has turned the plugin on.
 * @param {Request} req @param {string} pathname
 */
async function servePlugin(req, pathname) {
  if (req.mode === 'navigate') return deny('plugin files are not pages');
  const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(pathname);
  if (!m) return deny('not a plugin file');
  let id, path;
  try {
    // Stored paths are NFC (paths.js); a module written on a Mac may ask for the NFD spelling.
    id = decodeURIComponent(m[1]).normalize('NFC');
    path = `/${id}/${decodeURIComponent(m[2]).normalize('NFC')}`;
  } catch {
    return deny('not a plugin file');
  }
  /** @type {IDBDatabase | undefined} */
  let db;
  try {
    db = await openExisting();
    const found = await readFiles(db, 'sys:plugins', ['/installed.json', path]);
    let enabled = false;
    const state = found.get('/installed.json');
    if (state) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(state.data));
        enabled = Object.hasOwn(parsed, id) && parsed[id]?.enabled === true;
      } catch {
        enabled = false;
      }
    }
    if (!enabled) return deny('this plugin is not switched on');
    const file = found.get(path);
    if (!file) return new Response('not found', { status: 404 });
    if (!SAFE_PLUGIN_TYPES.has(file.type)) return deny('annai does not serve this kind of plugin file');
    return new Response(file.data, { headers: { 'Content-Type': file.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return new Response('plugin storage is not available', { status: 503 });
  } finally {
    db?.close();
  }
}

/**
 * Reads several files of a scope in one transaction.
 * @param {IDBDatabase} db @param {string} scope @param {string[]} paths
 * @returns {Promise<Map<string, { data: ArrayBuffer, type: string }>>}
 */
function readFiles(db, scope, paths) {
  return new Promise((resolve, reject) => {
    /** @type {Map<string, { data: ArrayBuffer, type: string }>} */
    const out = new Map();
    const t = db.transaction(['files', 'blobs'], 'readonly');
    for (const path of paths) {
      const f = t.objectStore('files').get([scope, path]);
      f.onsuccess = () => {
        const entry = f.result;
        if (!entry) return;
        const b = t.objectStore('blobs').get(entry.hash);
        b.onsuccess = () => { if (b.result) out.set(path, { data: b.result.data, type: entry.type }); };
      };
    }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Android's share sheet posts files here; they wait in a cache until the import screen opens them. @param {Request} req */
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const inbox = await caches.open(INBOX);
    // A new share replaces anything still waiting, so nothing lingers, and nothing another site
    // posted here earlier (any site can post to a share target) mixes into a real share.
    for (const key of await inbox.keys()) await inbox.delete(key);
    for (const f of form.getAll('files')) {
      if (!(f instanceof File)) continue;
      await inbox.put(`/inbox/${Date.now()}-${encodeURIComponent(f.name)}`, new Response(f, {
        headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Annai-Name': encodeURIComponent(f.name) },
      }));
    }
    // Text shared from another app (an email's words, a link) becomes a file, read like any other (spec §7.3).
    const shared = ['title', 'text', 'url'].map((k) => form.get(k)).filter((v) => typeof v === 'string' && v.trim()).join('\n\n').slice(0, 200_000);
    if (shared) {
      await inbox.put(`/inbox/${Date.now()}-text`, new Response(shared, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Annai-Name': encodeURIComponent('shared text.txt') },
      }));
    }
  } catch {
    // The import screen explains when the inbox is empty.
  }
  return Response.redirect(new URL('/#/import?inbox=1', sw.location.origin).href, 303);
}

// A reminder from the push relay (spec §11.6). Every push shows a notification, readable or not:
// Safari takes the subscription away after a few pushes that show none, even with annai open.
sw.addEventListener('push', (event) => {
  event.waitUntil(showReminder(/** @type {any} */ (event).data));
});

/** @param {any} data */
async function showReminder(data) {
  /** @type {any} */
  let m = null;
  try {
    m = data ? data.json() : null;
  } catch {
    m = null;
  }
  const ok = m !== null && typeof m === 'object' && typeof m.body === 'string' && m.body.trim() !== '' && typeof m.key === 'string';
  const title = ok && typeof m.title === 'string' && m.title.trim() ? m.title.slice(0, 120) : 'annai';
  // The page keeps its words for these in the screens' language (push/mirror.js pushWords), with what it gave itself.
  const kept = await readJson('sys:device', '/push.json');
  /** @type {Record<string, string>} */
  const words = kept?.words && typeof kept.words === 'object' ? kept.words : {};
  // A "coming up" says the minutes left now, from its start: one the phone held back too.
  const left = ok && Number.isFinite(m.start) && typeof m.what === 'string' ? Math.round((m.start - Date.now()) / 60_000) : null;
  const soon = left === null ? null : left > 0 ? words.soon : left === 0 ? words.now : words.ago;
  const body = !ok ? words.fallback || /* en */ 'annai has a reminder for you. Open annai to see it.'
    : typeof soon === 'string' && left !== null ? soon.replace('{0}', () => Math.abs(left).toLocaleString(words.lang)).replace('{1}', () => m.what.slice(0, 500)) : m.body.slice(0, 500);
  /** @type {Record<string, unknown>} */
  const info = ok ? { key: m.key.slice(0, 300), scope: String(m.scope ?? ''), watch: String(m.watch ?? ''), at: Number(m.at) || 0, ...(m.test ? { test: true } : {}) } : {};
  // One annai gave already that the phone held back comes quietly, and annai on screen closes it: a push
  // must show a notification (Safari drops the subscription after a few that don't; Chrome holds up the ones after it).
  const given = kept?.given;
  const stale = ok && !m.test && Boolean(given && typeof given === 'object' && Object.hasOwn(given, m.key));
  await sw.registration.showNotification(title, { body, tag: typeof info.key === 'string' ? info.key : 'annai-reminder', data: info, icon: '/assets/icons/icon-192.png', ...(stale ? { silent: true } : {}) });
  await keepNews({ kind: 'shown', ...info, ...(stale ? { stale: true } : {}), t: Date.now() });
}

/** One JSON file of the app's database, or null when it can't be had. @param {string} scope @param {string} path @returns {Promise<any>} */
async function readJson(scope, path) {
  /** @type {IDBDatabase | undefined} */
  let db;
  try {
    db = await openExisting();
    const file = (await readFiles(db, scope, [path])).get(path);
    return file ? JSON.parse(new TextDecoder().decode(file.data)) : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// Tapping one opens annai, whose catch-up says "opened the reminder for …" (spec §11.6). The tap is
// written down first: on iPhone the app may open at its start URL, and a message may not arrive.
sw.addEventListener('notificationclick', (event) => {
  const e = /** @type {any} */ (event);
  e.notification.close();
  e.waitUntil(openReminder(e.notification));
});

/** @param {any} n */
async function openReminder(n) {
  const info = n.data && typeof n.data === 'object' ? n.data : {};
  await keepNews({ kind: 'opened', ...info, title: String(n.title ?? ''), body: String(n.body ?? ''), t: Date.now() });
  const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((c) => new URL(c.url).origin === sw.location.origin);
  // An open annai comes forward; where the browser won't allow that, annai is opened, so the tap always leads somewhere.
  if (open && (await open.focus().then(() => true, () => false))) return;
  await sw.clients.openWindow('/');
}

// Chrome and Firefox renew a subscription themselves; annai sends its reminders to the new one next time it runs.
sw.addEventListener('pushsubscriptionchange', (event) => {
  /** @type {any} */ (event).waitUntil(renewSubscription(/** @type {any} */ (event)));
});

/** @param {any} event */
async function renewSubscription(event) {
  const key = event.oldSubscription?.options?.applicationServerKey;
  if (!event.newSubscription && key) {
    try {
      await sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch {
      // annai notices at its next start, and asks
    }
  }
  await keepNews({ kind: 'changed', t: Date.now() });
}

/** Keeps what happened until annai reads it (6b choice 10), and tells an open annai now. @param {Record<string, unknown>} news */
async function keepNews(news) {
  try {
    const box = await caches.open(PUSH_NEWS);
    await box.put(`/push-news/${Date.now()}-${Math.random().toString(36).slice(2)}`, new Response(JSON.stringify(news), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    // storage full: catch-up still covers the reminder
  }
  for (const c of await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'annai.push', kind: news.kind });
}
