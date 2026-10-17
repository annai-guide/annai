import { fromBase64Url, ownBuffer } from '../core/bytes.js';
import { platform, isStandalone } from './platform.js';

/**
 * The phone's side of notifications (spec §11.6): its push subscription and permission, what the
 * service worker saw, and closing a notification annai already said. Browser only.
 * @typedef {import('../core/push/mirror.js').Source} Source
 * @typedef {import('../core/push/mirror.js').Sub} Sub
 */

/** The service worker's news cache (sw.js PUSH_NEWS). */
export const PUSH_NEWS = 'annai-push';
/** The end-to-end tests' stand-in subscription (6b choice 16). */
const FAKE = 'annai.pushSubscription';

/** The service worker's registration, or a plain error after 10 s. @returns {Promise<ServiceWorkerRegistration>} */
function registration() {
  if (!('serviceWorker' in navigator)) return Promise.reject(new Error("This browser can't run annai's offline service, which shows notifications."));
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error("annai's offline service isn't running yet. Try again in a moment.")), 10_000)),
  ]);
}

/** @param {PushSubscription} s @returns {Sub} */
function subOf(s) {
  const p256dh = s.getKey('p256dh');
  const auth = s.getKey('auth');
  if (!p256dh || !auth) throw new Error("The phone's push subscription has no keys. Turn notifications off and on again.");
  return { endpoint: s.endpoint, p256dh: new Uint8Array(p256dh), auth: new Uint8Array(auth) };
}

/** The stand-in subscription, when a test set one. @returns {Sub | null} */
function fake() {
  try {
    const v = JSON.parse(localStorage.getItem(FAKE) ?? 'null');
    const p256dh = fromBase64Url(v?.p256dh);
    const auth = fromBase64Url(v?.auth);
    return typeof v?.endpoint === 'string' && p256dh && auth ? { endpoint: v.endpoint, p256dh, auth } : null;
  } catch {
    return null;
  }
}

/** @returns {Source} */
export function browserSource() {
  const stand = fake();
  let dropped = false;
  return {
    supported() {
      if (stand) return 'yes';
      // On iPhone, push works only in the Home Screen app (Apple, iOS 16.4+).
      if (platform() === 'ios' && !isStandalone()) return 'install';
      return 'serviceWorker' in navigator && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined' ? 'yes' : 'no';
    },
    permission() {
      if (stand) return 'granted';
      return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    },
    // Called first thing in the tap: iOS asks only during a user activation (6b choice 11).
    ask() {
      if (stand) return Promise.resolve('granted');
      if (typeof Notification === 'undefined') return Promise.resolve('denied');
      return Promise.resolve(Notification.requestPermission());
    },
    async get() {
      if (stand) return dropped ? null : stand;
      const s = await (await registration()).pushManager.getSubscription();
      return s ? subOf(s) : null;
    },
    async subscribe(key) {
      if (stand) {
        dropped = false;
        return stand;
      }
      const raw = fromBase64Url(key);
      if (!raw) throw new Error("The relay's key isn't one annai can use.");
      return subOf(await (await registration()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: ownBuffer(raw) }));
    },
    async unsubscribe() {
      if (stand) {
        dropped = true;
        return;
      }
      const s = await (await registration()).pushManager.getSubscription();
      await s?.unsubscribe();
    },
  };
}

/** What the service worker saw since annai last looked, oldest first; read once (6b choice 10). @returns {Promise<any[]>} */
export async function takeNews() {
  if (typeof caches === 'undefined') return [];
  const box = await caches.open(PUSH_NEWS);
  /** @type {any[]} */
  const out = [];
  for (const req of await box.keys()) {
    const res = await box.match(req);
    try {
      const v = await res?.json();
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // unreadable: dropped
    }
    await box.delete(req);
  }
  return out.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
}

/** Hears the service worker's "something happened" while annai is open. @param {() => void} fn */
export function onPushMessage(fn) {
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data && typeof e.data === 'object' && e.data.type === 'annai.push') fn();
  });
}

/** Closes the notifications for reminders annai already said on screen (6b choice 3). @param {string[]} keys */
export async function closeNotifications(keys) {
  if (!keys.length) return;
  for (const n of await (await registration()).getNotifications()) if (keys.includes(n.tag)) n.close();
}
