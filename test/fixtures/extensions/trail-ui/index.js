/**
 * A test plugin (milestone 8b): one of each slot, a card type, a plan row, a screen, a theme and a
 * hook, each drawing plain words a test can find.
 * @param {any} annai
 */
export function activate(annai) {
  const offs = [
    annai.ui.slot('status-chip', { id: 'trail', render: (/** @type {HTMLElement} */ el) => { el.textContent = 'Trail ok'; } }),
    annai.ui.slot('now-section', { id: 'trail', title: 'Trail', render: (/** @type {HTMLElement} */ el, /** @type {any} */ ui) => { el.append(ui.h('p', { text: 'Trail section' })); } }),
    annai.ui.slot('dock-action', { id: 'check', label: 'Trail check', icon: '⛰', run: (/** @type {any} */ ui) => ui.toast('Trail checked') }),
    annai.ui.slot('trip-tab', { id: 'log', title: 'Trail log', render: (/** @type {HTMLElement} */ el, /** @type {any} */ ui, /** @type {{ trip: string }} */ at) => { el.append(ui.h('p', { text: `Trail log for ${at.trip}` })); } }),
    annai.ui.slot('settings-page', { id: 'settings', title: 'Trail settings', render: (/** @type {HTMLElement} */ el, /** @type {any} */ ui) => { el.append(ui.h('p', { text: 'Trail settings page' })); } }),
    annai.ui.cardType({
      type: 'trail', name: 'Trail', description: 'A trail, by name.',
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      render: (/** @type {any} */ data, /** @type {HTMLElement} */ el, /** @type {any} */ ui) => { el.append(ui.h('p', { class: 'trail-card', text: `Trail: ${data.name}` })); },
    }),
    annai.ui.component('plan-row', { render: (/** @type {HTMLElement} */ el, /** @type {any} */ row) => { el.textContent = `${row.when} · ${row.title} (trail row)`; } }),
    annai.ui.screen({ id: 'hike', title: 'Hike', tab: true, homeFor: 'walking', render: (/** @type {HTMLElement} */ el, /** @type {any} */ ui) => { el.append(ui.h('p', { text: 'Hike screen' })); } }),
    annai.ui.theme('theme.css'),
    annai.hooks.on(() => {
      const g = /** @type {any} */ (globalThis);
      g.__trailWrites = (g.__trailWrites ?? 0) + 1;
    }, { types: ['file.write'] }),
  ];
  return () => offs.forEach((off) => off());
}
