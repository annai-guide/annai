import { readAppSettings, updateAppSettings } from '../core/settings.js';

/**
 * When the welcome shows (the user, 2026-10-18): once per device, the first time annai opens at its
 * start. It is noted in the app's settings (welcomedAt) when it is first drawn, so Erase brings it back.
 * @typedef {import('../core/workspace.js').Workspace} Workspace
 * @typedef {{ hash: string, search: string }} Address
 */

/**
 * Whether annai opened at its start, "/" with no screen in its address. A link to a screen (a shared
 * trip, a share, the OpenRouter sign-in coming back, any "#/…") is never interrupted: the welcome waits
 * for the next plain start.
 * @param {Address} at
 */
export function plainStart({ hash, search }) {
  return search === '' && (hash === '' || hash === '#' || hash === '#/');
}

/** @param {Workspace} ws @param {Address} at */
export async function shouldWelcome(ws, at) {
  if (!plainStart(at)) return false;
  return typeof (await readAppSettings(ws)).welcomedAt !== 'number';
}

/** Notes that this device has seen the welcome; the first time stays. @param {Workspace} ws @param {number} [now] */
export async function markWelcomed(ws, now = Date.now()) {
  if (typeof (await readAppSettings(ws)).welcomedAt === 'number') return;
  await updateAppSettings(ws, { welcomedAt: now });
}
