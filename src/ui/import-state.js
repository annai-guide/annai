/**
 * Files picked or dropped on one screen and opened on the import screen (hash routes can't carry files).
 * @typedef {{ target: string, remote: import('../core/backup-targets.js').RemoteBackup }} From a backup opened from a backup place
 */
/** @type {{ files: File[], archive: boolean, from: From | null } | null} */
let pending = null;
/**
 * @param {File[]} files @param {{ archive?: boolean, from?: From | null }} [o]
 *   archive: picked as an annai file, so it is one whatever its name; from: the backup place it came from
 */
export function setPendingImport(files, { archive = false, from = null } = {}) { pending = files.length ? { files, archive, from } : null; }
export function takePendingImport() {
  const f = pending;
  pending = null;
  return f;
}

/** An annai archive (or a zip that may be one), as opposed to a file for a trip, such as a Wallet pass. @param {string} name */
export function isArchiveName(name) {
  return /\.annai(\.zip)?$/i.test(name) || /\.zip$/i.test(name);
}
