/**
 * The package the install screen shows: read and checked, not yet stored (hash routes can't carry
 * files). It stays until it is installed or the user cancels.
 * @typedef {{ files: Map<string, Uint8Array>, pkg: any, from: { source: 'file', file: string } | { source: 'url', url: string } }} PendingPackage
 */
/** @type {PendingPackage | null} */
let pending = null;

/** @param {PendingPackage | null} p */
export function setPendingPackage(p) {
  pending = p;
}

export function pendingPackage() {
  return pending;
}
