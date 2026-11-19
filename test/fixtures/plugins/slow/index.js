// A plugin that starts as slowly as the test says: a phone that is slow to start a plugin (form-keep.spec.js).
/** @param {any} annai */
export function activate(annai) {
  /** @type {any} */ (globalThis).__addPage = () => annai.ui.slot('settings-page', { id: 'later', title: 'Later', render: (/** @type {HTMLElement} */ el) => { el.textContent = 'added later'; } });
  return /** @type {any} */ (globalThis).__hold ? new Promise((resolve) => { /** @type {any} */ (globalThis).__release = resolve; }) : undefined;
}
