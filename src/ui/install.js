import { h, t } from './dom.js';
import { isStandalone, platform } from './platform.js';
import { sentenceGap } from './format.js';

/** @type {any} */
let deferred = null;
/** The Install buttons drawn, shown once the browser offers to install: one listener for all of them. @type {Set<HTMLElement>} */
const buttons = new Set();
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  for (const b of buttons) b.hidden = false;
});

/** How to install annai on each platform; the welcome's last step shows them too. */
export const STEPS = {
  ios: [t`Tap the Share button in Safari.`, t`Choose "Add to Home Screen".`, t`Open annai from your Home Screen.`],
  android: [t`Open the browser menu (⋮).`, t`Choose "Install and create shortcut", then "Install".`, t`Open annai from your Home screen.`],
  desktop: [t`Use your browser menu to install annai as an app.`],
};
/** The banner's last step on an iPhone, for trips already kept in Safari (a fresh device, the welcome's, has none). */
const TRIPS_HERE = t`Trips you already have here: in Settings, export everything, then open the file in the Home Screen app with "Open a trip someone sent you".`;

/** The Install button, shown where the browser offers to install annai (Chrome on Android). */
export function installButton() {
  const install = h('button', {
    class: 'btn pri', type: 'button', hidden: !deferred,
    onclick: async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      install.hidden = true;
    },
  }, t`Install annai`);
  // Buttons no longer on screen (an earlier step of the welcome) are let go.
  for (const b of buttons) if (!b.isConnected) buttons.delete(b);
  buttons.add(install);
  return install;
}

/** The data-safety warning shown until annai runs installed (spec §2, §17 rule 1). */
export function installBanner() {
  if (isStandalone()) return h('div', { hidden: true });
  const p = platform();
  const how = h('ol', { class: 'steps', hidden: true }, ...[...STEPS[p], ...(p === 'ios' ? [TRIPS_HERE] : [])].map((s) => h('li', { text: s })));
  const install = installButton();
  return h('section', { class: 'risk', 'aria-label': t`Install annai` },
    h('p', {}, h('strong', { text: t`annai isn't installed yet.` }), sentenceGap(),
      p === 'ios'
        ? t`Safari can erase your trips after 7 days without a visit, and the Home Screen app keeps trips of its own: what you start here won't be there. Add annai to your Home Screen, and start your trips in it.`
        : t`Your browser may clear your trips when space runs low. Install annai to keep them safe.`),
    h('div', { class: 'acts' }, install, h('button', { class: 'btn', type: 'button', onclick: () => { how.hidden = !how.hidden; } }, t`Show me how`)),
    how);
}
