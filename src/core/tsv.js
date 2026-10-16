/**
 * TSV for the model (spec §4.7): flat lists with a header row. Cells escape "<", tabs and line
 * breaks with the TSVZ tokens <lt>, <sep>, <LF> and <CR>. Objects in a cell are JSON.
 */

/** @param {unknown} v */
export function cell(v) {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.replaceAll('<', '<lt>').replaceAll('\t', '<sep>').replaceAll('\n', '<LF>').replaceAll('\r', '<CR>');
}

/** @param {string[]} header @param {unknown[][]} rows */
export function tsv(header, rows) {
  return [header, ...rows].map((r) => r.map(cell).join('\t')).join('\n');
}
