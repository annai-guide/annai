import { h } from '../dom.js';
import { markWelcomed } from '../welcome.js';
import { keysAndData, finePrint } from '../privacy.js';
import { STEPS as INSTALL_STEPS, installButton } from '../install.js';
import { platform, isStandalone } from '../platform.js';
import { readyFeatured } from '../provider-setup.js';
import { officialPlugins } from '../../core/llm/official.js';

/**
 * The welcome (the user, 2026-10-18): five short steps in annai's own words, not Shiori's, at
 * #/welcome and #/welcome/2 to 5. It shows once per device at annai's plain start (../welcome.js), and
 * again from Settings → About. Each step's heading takes the focus; Next, Back and Skip are buttons, so
 * a keyboard reaches them in every browser; the last step is the onboarding: installing annai where
 * it isn't, then Settings → Models with the catalog's featured provider's sign-in (spec §9.8).
 */

const TITLES = ['Welcome to annai', 'What annai can do', 'Your keys and your data', 'The fine print', 'Get started'];
const LAST = TITLES.length;

/** @param {number} n */
const stepHash = (n) => (n === 1 ? '#/welcome' : `#/welcome/${n}`);

/** @param {string} lead @param {string} text */
const can = (lead, text) => h('li', {}, h('strong', { text: lead }), ' ', text);

/** @param {number} n @param {any} ctx @returns {any[]} */
function body(n, ctx) {
  if (n === 1) {
    return [
      h('p', { class: 'lead', text: 'annai is a free, open-source travel guide that lives on your phone.' }),
      h('p', { text: 'Its guide is Shiori. She plans the trip with you, keeps your bookings and notes, reminds you at the right time and place, talks with you on the road, and makes a recap afterwards.' }),
      h('p', { class: 'sub', text: 'She is at the bottom of every screen: tap her to talk, or type.' }),
      h('p', { class: 'sub', text: 'annai (案内) is Japanese for "guidance; showing someone around".' }),
    ];
  }
  if (n === 2) {
    return [h('ul', { class: 'can' },
      can('Plans and bookings.', 'Plan the trip day by day with Shiori, and add your confirmations: PDFs, Wallet passes, screenshots. You book; annai never books for you.'),
      can('GPS.', "With GPS on, annai follows where you are and reminds you at the right time and place: when to leave, when you've arrived, when you're running late."),
      can('Voice.', 'Talk with Shiori hands-free, in the car or on a trail.'),
      can('Offline places.', "OpenStreetMap places, Wikipedia summaries and Wikivoyage guides along your plan, for when there's no signal."),
      can('Photos.', 'Show Shiori what you see, and ask about it.'),
      can('Backups.', 'Export a file, or back up automatically to GitHub, a Forgejo or Gitea server, an S3 bucket or a WebDAV folder.'),
      can('Plugins and MCP servers.', 'Skills, tools and screens that others make.'),
      can('Recap and replay.', 'Afterwards, a recap of the trip, and its route played back.'))];
  }
  if (n === 3) return [h('p', { class: 'lead', text: 'annai is built so your keys and data stay yours. Here is exactly how, and where that stops.' }), ...keysAndData('h2')];
  if (n === 4) return finePrint();
  return start(ctx);
}

/** Whether this is Safari on an iPhone, where a model set up here stays in Safari, apart from the Home Screen app. */
const inSafari = () => platform() === 'ios' && !isStandalone();

/**
 * The last step: install where annai isn't installed, then connect a model, with the featured provider's
 * sentence from annai's catalog (none while a provider exists). Its plugin installs now, in the background,
 * so its sign-in on Models is ready before the tap; the sentence doesn't wait for that. Not in Safari on an
 * iPhone, where the model is set up in the Home Screen app. @param {any} ctx
 */
function start(ctx) {
  const p = platform();
  const lead = h('p', {});
  const say = (/** @type {string} */ featured) => {
    lead.textContent = [inSafari() ? 'Connect a model there, so Shiori can think.' : 'Connect a model, so Shiori can think.', featured, inSafari() ? 'A model set up here, in Safari, stays in Safari.' : ''].filter(Boolean).join(' ');
  };
  say('');
  Promise.all([officialPlugins(), ctx.llm.config()]).then(([list, cfg]) => {
    const f = list.find((x) => typeof x.featured === 'string' && x.featured);
    if (f && !Object.keys(cfg.providers).length) say(String(f.featured));
  }, () => {});
  if (!inSafari()) readyFeatured(ctx).catch(() => {});
  const model = [lead];
  if (isStandalone() || p === 'desktop') {
    return [...model, ...(p === 'desktop' && !isStandalone() ? [h('p', { class: 'sub', text: 'You can also install annai as an app from your browser\'s menu.' })] : [])];
  }
  // The step about trips already kept in Safari is for later: a fresh device has none.
  const steps = INSTALL_STEPS[p].filter((s) => !s.startsWith('Trips you already have'));
  return [
    h('h2', { class: 'section', text: 'First, install annai' }),
    h('p', {
      text: p === 'ios'
        ? 'Safari can erase what annai keeps after 7 days without a visit, and the Home Screen app keeps data of its own. Add annai to your Home Screen, and set up your model there.'
        : 'Your browser may clear what annai keeps when space runs low. Install annai to keep your trips safe.',
    }),
    h('ol', { class: 'steps' }, ...steps.map((s) => h('li', { text: s }))),
    // Only Chrome on Android offers to install from a button; Safari has none.
    p === 'android' ? h('div', { class: 'acts' }, installButton()) : null,
    h('h2', { class: 'section', text: p === 'ios' ? 'Then, in the Home Screen app' : 'Then' }),
    ...model,
  ];
}

/** @param {any} ctx @param {{ parts: string[] }} route */
export async function renderWelcome(ctx, route) {
  const n = Math.min(LAST, Math.max(1, Number.parseInt(route.parts[1] ?? '1', 10) || 1));
  // Drawn once, it is seen: shown once per device (the user, 2026-10-18).
  await markWelcomed(ctx.ws).catch(() => {});
  const title = h('h1', { class: 'title', tabindex: '-1', text: TITLES[n - 1] });
  const go = (/** @type {string} */ hash) => () => ctx.go(hash);
  const nav = n < LAST
    ? [
      h('button', { class: 'btn pri', type: 'button', onclick: go(stepHash(n + 1)) }, 'Next'),
      n > 1 ? h('button', { class: 'btn', type: 'button', onclick: go(stepHash(n - 1)) }, 'Back') : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: go(stepHash(LAST)) }, 'Skip'),
    ]
    // In Safari on an iPhone the model belongs in the Home Screen app, so looking around comes first there.
    : [
      ...(inSafari()
        ? [h('button', { class: 'btn pri', type: 'button', onclick: go('#/trips') }, 'Look around first'),
          h('button', { class: 'btn', type: 'button', onclick: go('#/models') }, 'Set up a model')]
        : [h('button', { class: 'btn pri', type: 'button', onclick: go('#/models') }, 'Set up a model'),
          h('button', { class: 'btn', type: 'button', onclick: go('#/trips') }, 'Look around first')]),
      h('button', { class: 'btn ghost', type: 'button', onclick: go(stepHash(n - 1)) }, 'Back'),
    ];
  const screen = h('div', { class: 'screen welcome', dataset: { step: String(n) } },
    h('p', { class: 'step', text: `${n} of ${LAST}` }),
    title,
    ...body(n, ctx),
    h('div', { class: 'acts' }, ...nav));
  // Once the shell has put the step on screen, its heading takes the focus, so a screen reader starts there.
  setTimeout(() => { if (title.isConnected) title.focus(); }, 0);
  return screen;
}
