/**
 * Files picked or dropped on one screen and opened on the import screen (hash routes can't carry files).
 * @typedef {{ target: string, remote: import('../core/backup-targets.js').RemoteBackup }} From a backup opened from a backup place
 */
/** @type {{ files: File[], archive: boolean, from: From | null, peeked: any } | null} */
let pending = null;
/**
 * @param {File[]} files @param {{ archive?: boolean, from?: From | null, peeked?: any }} [o]
 *   archive: picked as an annai file, so it is one whatever its name; from: the backup place it came from;
 *   peeked: that backup's manifest, when the place told it without sending the files (they come when the user imports)
 */
export function setPendingImport(files, { archive = false, from = null, peeked = null } = {}) { pending = files.length || (peeked && from) ? { files, archive, from, peeked } : null; }
export function takePendingImport() {
  const f = pending;
  pending = null;
  return f;
}

/** An annai archive (or a zip that may be one), as opposed to a file for a trip, such as a Wallet pass. @param {string} name */
export function isArchiveName(name) {
  return /\.annai(\.zip)?$/i.test(name) || /\.zip$/i.test(name);
}
