/** A file picked on one screen and opened on the import screen (hash routes can't carry files). */
/** @type {File | null} */
let pending = null;
/** @param {File} file */
export function setPendingImport(file) { pending = file; }
export function takePendingImport() {
  const f = pending;
  pending = null;
  return f;
}
