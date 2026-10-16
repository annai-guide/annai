/* annai service worker: offline app shell, installed plugin files, Android share target (spec §3). */
const VERSION = '0.1.0';
// A hash of the SHELL files, written by scripts/stamp.mjs: any change to them makes a new cache.
const BUILD = '4caacfa51b87';
const CACHE = `annai-shell-${VERSION}-${BUILD}`;
const INBOX = 'annai-inbox';
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
const DEV = ['localhost', '127.0.0.1'].includes(sw.location.hostname);
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
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
  '/assets/shiori.svg',
  '/src/app/main.js',
  '/src/app/version.js',
  '/src/core/archive-crypto.js',
  '/src/core/archive.js',
  '/src/core/bytes.js',
  '/src/core/crc32.js',
  '/src/core/errors.js',
  '/src/core/events.js',
  '/src/core/hash.js',
  '/src/core/llm/call.js',
  '/src/core/llm/config.js',
  '/src/core/llm/contract.js',
  '/src/core/llm/fallback.js',
  '/src/core/llm/official.js',
  '/src/core/llm/cost.js',
  '/src/core/llm/partial-json.js',
  '/src/core/llm/reasoning.js',
  '/src/core/llm/retry.js',
  '/src/core/llm/service.js',
  '/src/core/llm/sse.js',
  '/src/core/llm/templates.js',
  '/src/core/llm/trace.js',
  '/src/core/lock.js',
  '/src/core/patch.js',
  '/src/core/photo-meta.js',
  '/src/core/photos.js',
  '/src/core/paths.js',
  '/src/core/plugins.js',
  '/src/core/registry.js',
  '/src/core/schema.js',
  '/src/core/scopes.js',
  '/src/core/settings.js',
  '/src/core/store-idb.js',
  '/src/core/store-memory.js',
  '/src/core/types.js',
  '/src/core/workspace.js',
  '/src/core/zip.js',
  '/src/plugins/core-schemas/index.js',
  '/src/plugins/core-schemas/schemas.js',
  '/src/ui/base.css',
  '/src/ui/dom.js',
  '/src/ui/add-files.js',
  '/src/ui/ask.js',
  '/src/ui/export-panel.js',
  '/src/ui/format.js',
  '/src/ui/import-state.js',
  '/src/ui/install.js',
  '/src/ui/notices.js',
  '/src/ui/open-file.js',
  '/src/ui/photo-codec.js',
  '/src/ui/photo-viewer.js',
  '/src/ui/platform.js',
  '/src/ui/router.js',
  '/src/ui/save.js',
  '/src/ui/screens/file.js',
  '/src/ui/screens/import.js',
  '/src/ui/screens/plugins.js',
  '/src/ui/screens/settings.js',
  '/src/ui/screens/trace.js',
  '/src/ui/screens/trip.js',
  '/src/ui/screens/trips.js',
  '/src/ui/shell.js',
  '/src/ui/storage-full.js',
  '/src/ui/tokens.css',
];

sw.addEventListener('install', (event) => {
  // Past the HTTP cache: a new version must never store a stale copy of one of its files.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('annai-shell-') && key !== CACHE) await caches.delete(key);
    await sw.clients.claim();
  })());
});

// A new version waits until annai restarts; it only takes over early when the user taps "Restart now" (spec §17 rule 5).
sw.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') sw.skipWaiting();
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
  event.respondWith(respond(req, req.mode === 'navigate' ? '/index.html' : null));
});

/** Production: cache first. Development (localhost): network first, so edits show up. @param {Request} req @param {string | null} fallback */
async function respond(req, fallback) {
  const cache = await caches.open(CACHE);
  const cached = () => cache.match(fallback ?? req, { ignoreSearch: true });
  if (DEV) {
    try {
      return await fetch(req);
    } catch {
      return (await cached()) ?? Response.error();
    }
  }
  return (await cached()) ?? fetch(req);
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
    const found = await readPluginFiles(db, ['/installed.json', path]);
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
 * Reads several sys:plugins files in one transaction.
 * @param {IDBDatabase} db @param {string[]} paths
 * @returns {Promise<Map<string, { data: ArrayBuffer, type: string }>>}
 */
function readPluginFiles(db, paths) {
  return new Promise((resolve, reject) => {
    /** @type {Map<string, { data: ArrayBuffer, type: string }>} */
    const out = new Map();
    const t = db.transaction(['files', 'blobs'], 'readonly');
    for (const path of paths) {
      const f = t.objectStore('files').get(['sys:plugins', path]);
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
  } catch {
    // The import screen explains when the inbox is empty.
  }
  return Response.redirect(new URL('/#/import?inbox=1', sw.location.origin).href, 303);
}
