// A third party's plugin with a Japanese translation (localization L7's e2e): its words go through annai.l10n.
/** @param {any} annai */
export function activate(annai) {
  const { l10n } = annai;
  return annai.ui.slot('settings-page', { id: 'tides', title: l10n.t`Tide tables`, render: (/** @type {HTMLElement} */ el) => { el.textContent = l10n.t`Low tide at ${'4:12'}.`; } });
}
