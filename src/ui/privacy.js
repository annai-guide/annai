import { h, t } from './dom.js';

/**
 * What the welcome and Settings → About say about keys and data, and the fine print (the user,
 * 2026-10-18), in one place so the two never differ. Each claim is true of the code: the plan
 * (docs/superpowers/plans/2026-10-18-welcome-about.md) and its report name the code for each.
 */

export const REPO = 'https://github.com/annai-guide/annai';
/** The licence names itself in English. */
const LICENCE = /* en */ 'GNU Affero General Public License 3.0';

/** @param {string} lead @param {...any} rest */
const fact = (lead, ...rest) => h('li', {}, h('strong', { text: lead }), ' ', ...rest);
/** A sentence with the link where it says the link's words (a value of the message). @param {string} text @param {HTMLElement} link */
const linkIn = (text, link) => {
  const [before, after] = text.split(link.textContent ?? '');
  return [before, link, after];
};

/** The facts, then where they stop. @param {'h2' | 'h3'} level the heading level for "Where this stops" */
export function keysAndData(level) {
  return [
    h('ul', { class: 'facts-list' },
      fact(t`Kept on this device.`, t`Your trips, files, settings and keys are stored in this browser, on this device. annai has no accounts, and no server of annai's keeps your trips or your keys.`),
      fact(t`Sent only where it's needed.`, t`What you ask Shiori goes to the model provider you connect, with what she needs from your trip, and what you say goes where Settings → Voice shows. Places she looks up go to the sources credited in Settings → About. The Trace shows every request annai sends for Shiori: her model calls, her tools and the offline pack.`),
      fact(t`Your keys stay yours.`, t`Each model key is kept in this device's storage and sent only to the provider it is for. Keys are never put in what Shiori's model reads, are blanked out of the Trace, and are left out of exports, unless you choose to put them in an encrypted backup.`),
      fact(t`No tracking.`, t`annai has no analytics and no ads. It loads no scripts from other sites: its content security policy lets only scripts from annai's own address run, except code plugins you install, which annai stores and serves itself.`),
      fact(t`Reminders stay sealed.`, t`With notifications on, the push relay holds each time reminder encrypted on this device, and keeps only the phone's push address, when each is due, how many are waiting, and little else: a cancel code for each, and a note that this phone has received one. Reminders about places never leave the phone.`),
      fact(t`Open code.`, ...linkIn(t`annai's code is open under the AGPL-3.0 for anyone to read, at ${REPO.replace('https://', '')}.`, h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer', text: REPO.replace('https://', '') })))),
    h(level, { class: 'sub-head', text: t`Where this stops` }),
    h('ul', { class: 'facts-list limits' },
      h('li', { text: t`A code plugin you install runs with full trust: it can read your trips and keys, and its requests can bypass the Trace. Install only plugins you trust.` }),
      h('li', { text: t`With your model's own search or fetch (Settings → Tools), the searches and pages run on the provider's servers, and the Trace shows only the model's turn.` }),
      h('li', { text: t`Your keys are as safe as this device: anyone who can use this browser on it can reach them. Keep it locked.` }),
      h('li', { text: t`On iPhone, Safari and the Home Screen app keep separate data: keys and trips you add in one aren't in the other.` })),
  ];
}

/** The disclaimer, in plain words. */
export function finePrint() {
  return [
    h('p', {}, ...linkIn(t`annai is free software, provided as is, without any warranty, as far as the law allows, under the ${LICENCE} (AGPL-3.0).`, h('a', { href: '#/about/licence', text: LICENCE }))),
    h('p', { text: t`Shiori is an AI, and she can be wrong. Check bookings, prices, opening hours, routes and safety information yourself.` }),
    h('p', { text: t`When you drive, use her hands-free, and follow the road and the local rules.` }),
    h('p', { text: t`What the model provider you connect charges is yours to pay. What you import, fetch or connect is your responsibility.` }),
  ];
}
