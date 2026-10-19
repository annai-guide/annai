/**
 * A test plugin (milestone 6 of providers as plugins): replaces the avatar, and says so in its manifest.
 * @param {any} annai
 */
export function activate(annai) {
  return annai.ui.component('avatar', {
    create: () => {
      const el = document.createElement('span');
      el.className = 'mountain-avatar';
      el.textContent = '⛰';
      return { el, setState() {}, setLevel() {}, glance() {}, blink() {} };
    },
  });
}
