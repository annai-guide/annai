import { h } from './dom.js';
import { isStandalone, platform } from './platform.js';

/** @type {any} */
let deferred = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
});

const STEPS = {
  ios: ['Tap the Share button in Safari.', 'Choose "Add to Home Screen".', 'Open annai from your Home Screen.'],
  android: ['Open the browser menu (⋮).', 'Choose "Install app" or "Add to Home screen".', 'Open annai from your Home screen.'],
  desktop: ['Use your browser menu to install annai as an app.'],
};

/** The data-safety warning shown until annai runs installed (spec §2, §17 rule 1). */
export function installBanner() {
  if (isStandalone()) return h('div', { hidden: true });
  const p = platform();
  const how = h('ol', { class: 'steps', hidden: true }, ...STEPS[p].map((s) => h('li', { text: s })));
  const install = h('button', {
    class: 'btn pri', type: 'button', hidden: !deferred,
    onclick: async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      install.hidden = true;
    },
  }, 'Install annai');
  addEventListener('beforeinstallprompt', () => { install.hidden = false; });
  return h('section', { class: 'risk', 'aria-label': 'Install annai' },
    h('p', {}, h('strong', { text: "annai isn't installed yet." }), ' ',
      p === 'ios'
        ? 'Safari can erase your trips after 7 days without a visit. Add annai to your Home Screen to keep them.'
        : 'Your browser may clear your trips when space runs low. Install annai to keep them safe.'),
    h('div', { class: 'acts' }, install, h('button', { class: 'btn', type: 'button', onclick: () => { how.hidden = !how.hidden; } }, 'Show me how')),
    how);
}
