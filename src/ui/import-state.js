/** Files picked or dropped on one screen and opened on the import screen (hash routes can't carry files). */
/** @type {{ files: File[], archive: boolean } | null} */
let pending = null;
/** @param {File[]} files @param {{ archive?: boolean }} [o] archive: picked as an annai file, so it is one whatever its name */
export function setPendingImport(files, { archive = false } = {}) { pending = files.length ? { files, archive } : null; }
export function takePendingImport() {
  const f = pending;
  pending = null;
  return f;
}

/** An annai archive (or a zip that may be one), as opposed to a file for a trip, such as a Wallet pass. @param {string} name */
export function isArchiveName(name) {
  return /\.annai(\.zip)?$/i.test(name) || /\.zip$/i.test(name);
}
