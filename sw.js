/* annai service worker: offline app shell, installed plugin files, Android share target (spec §3). */
const VERSION = '0.1.0';
const CACHE = `annai-shell-${VERSION}`;
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
  '/src/core/events.js',
  '/src/core/hash.js',
  '/src/core/lock.js',
  '/src/core/patch.js',
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
  '/src/ui/format.js',
  '/src/ui/import-state.js',
  '/src/ui/install.js',
  '/src/ui/notices.js',
  '/src/ui/open-file.js',
  '/src/ui/platform.js',
  '/src/ui/router.js',
  '/src/ui/screens/trips.js',
  '/src/ui/shell.js',
  '/src/ui/tokens.css',
];

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
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
    event.respondWith(servePlugin(url.pathname));
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
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Serves /plugins/<id>/<file> from the sys:plugins scope. @param {string} pathname */
async function servePlugin(pathname) {
  const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(pathname);
  if (!m) return new Response('not found', { status: 404 });
  const path = `/${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
  /** @type {IDBDatabase | undefined} */
  let db;
  try {
    db = await openExisting();
    const found = await new Promise((resolve, reject) => {
      const t = /** @type {IDBDatabase} */ (db).transaction(['files', 'blobs'], 'readonly');
      const f = t.objectStore('files').get(['sys:plugins', path]);
      f.onsuccess = () => {
        const entry = f.result;
        if (!entry) {
          resolve(null);
          return;
        }
        const b = t.objectStore('blobs').get(entry.hash);
        b.onsuccess = () => resolve(b.result ? { data: b.result.data, type: entry.type } : null);
      };
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    if (!found) return new Response('not found', { status: 404 });
    return new Response(found.data, { headers: { 'Content-Type': found.type, 'Cache-Control': 'no-cache' } });
  } catch {
    return new Response('plugin storage is not available', { status: 503 });
  } finally {
    db?.close();
  }
}

/** Android's share sheet posts files here; they wait in a cache until the import screen opens them. @param {Request} req */
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const inbox = await caches.open(INBOX);
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
