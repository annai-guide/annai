import { h } from './dom.js';

/**
 * What the welcome and Settings → About say about keys and data, and the fine print (the user,
 * 2026-10-18), in one place so the two never differ. Each claim is true of the code: the plan
 * (docs/superpowers/plans/2026-10-18-welcome-about.md) and its report name the code for each.
 */

export const REPO = 'https://github.com/annai-guide/annai';

/** @param {string} lead @param {...any} rest */
const fact = (lead, ...rest) => h('li', {}, h('strong', { text: lead }), ' ', ...rest);

/** The facts, then where they stop. @param {'h2' | 'h3'} level the heading level for "Where this stops" */
export function keysAndData(level) {
  return [
    h('ul', { class: 'facts-list' },
      fact('Kept on this device.', 'Your trips, files, settings and keys are stored in this browser, on this device. annai has no accounts, and no server of annai\'s keeps your trips or your keys.'),
      fact('Sent only where it\'s needed.', 'What you ask Shiori goes to the model provider you connect, with what she needs from your trip, and what you say goes where Settings → Voice shows. Places she looks up go to the sources credited in Settings → About. The Trace shows every request annai sends for Shiori: her model calls, her tools and the offline pack.'),
      fact('Your keys stay yours.', 'Each model key is kept in this device\'s storage and sent only to the provider it is for. Keys are never put in what Shiori\'s model reads, are blanked out of the Trace, and are left out of exports, unless you choose to put them in an encrypted backup.'),
      fact('No tracking.', 'annai has no analytics and no ads. It loads no scripts from other sites: its content security policy lets only scripts from annai\'s own address run, except code plugins you install, which annai stores and serves itself.'),
      fact('Reminders stay sealed.', 'With notifications on, the push relay holds each time reminder encrypted on this device, and keeps only the phone\'s push address, when each is due, how many are waiting, and little else: a cancel code for each, and a note that this phone has received one. Reminders about places never leave the phone.'),
      fact('Open code.', 'annai\'s code is open under the AGPL-3.0 for anyone to read, at ', h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer', text: 'github.com/annai-guide/annai' }), '.')),
    h(level, { class: 'sub-head', text: 'Where this stops' }),
    h('ul', { class: 'facts-list limits' },
      h('li', { text: 'A code plugin you install runs with full trust: it can read your trips and keys, and its requests can bypass the Trace. Install only plugins you trust.' }),
      h('li', { text: 'With your model\'s own search or fetch (Settings → Tools), the searches and pages run on the provider\'s servers, and the Trace shows only the model\'s turn.' }),
      h('li', { text: 'Your keys are as safe as this device: anyone who can use this browser on it can reach them. Keep it locked.' }),
      h('li', { text: 'On iPhone, Safari and the Home Screen app keep separate data: keys and trips you add in one aren\'t in the other.' })),
  ];
}

/** The disclaimer, in plain words. */
export function finePrint() {
  return [
    h('p', {}, 'annai is free software, provided as is, without any warranty, as far as the law allows, under the ',
      h('a', { href: '#/about/licence', text: 'GNU Affero General Public License 3.0' }), ' (AGPL-3.0).'),
    h('p', { text: 'Shiori is an AI, and she can be wrong. Check bookings, prices, opening hours, routes and safety information yourself.' }),
    h('p', { text: 'When you drive, use her hands-free, and follow the road and the local rules.' }),
    h('p', { text: 'What the model provider you connect charges is yours to pay. What you import, fetch or connect is your responsibility.' }),
  ];
}
