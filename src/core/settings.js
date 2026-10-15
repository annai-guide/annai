import { SYS_SETTINGS } from './scopes.js';

/** @typedef {import('./workspace.js').Workspace} Workspace */
const APP = '/app.json';

/** @param {Workspace} ws @returns {Promise<Record<string, any>>} */
export async function readAppSettings(ws) {
  return (await ws.readJSON(SYS_SETTINGS, APP)) ?? {};
}

/** Merges changes into the app settings (null removes a key), creating the file the first time. @param {Workspace} ws @param {Record<string, any>} changes */
export async function updateAppSettings(ws, changes) {
  return ws.patch(SYS_SETTINGS, APP, changes, { author: 'system', create: true });
}
