import { h, t, linkIn } from '../dom.js';
import { lang } from '../../core/l10n.js';
import { SHIPPED } from '../../core/l10n-list.js';
import { ownName } from '../languages.js';
import { num, sentences, sentenceGap } from '../format.js';
import { markWelcomed } from '../welcome.js';
import { keysAndData, finePrint } from '../privacy.js';
import { STEPS as INSTALL_STEPS, installButton } from '../install.js';
import { platform, isStandalone } from '../platform.js';
import { readyFeatured } from '../provider-setup.js';
import { officialPlugins } from '../../core/llm/official.js';
import { freeTicks, WELCOME_SEARCH } from '../search-panel.js';

/**
 * The welcome (the user, 2026-10-18): six short steps in annai's own words, not Shiori's, at
 * #/welcome and #/welcome/2 to 6. It shows once per device at annai's plain start (../welcome.js), and
 * again from Settings → About. Each step's heading takes the focus; Next, Back and Skip are buttons, so
 * a keyboard reaches them in every browser; the last step is the onboarding: installing annai where
 * it isn't, then Settings → Models with the catalog's featured provider's sign-in (spec §9.8).
 */

/** The steps, each by an id its body is found by (not its number, so a step added between them moves nothing). */
const STEPS = /** @type {const} */ ([['welcome', t`Welcome to annai`], ['halves', t`Shiori, Koe and Kokoro`], ['can', t`What annai can do`], ['keys', t`Your keys and your data`], ['fine', t`The fine print`], ['search', t`Searching the web`], ['start', t`Get started`]]);
const TITLES = STEPS.map((s) => s[1]);
const LAST = STEPS.length;
/** @param {number} n */
const idOf = (n) => STEPS[n - 1][0];

/** @param {number} n */
const stepHash = (n) => (n === 1 ? '#/welcome' : `#/welcome/${n}`);

/** A thing annai can do: its name in bold, a sentence after. @param {string | Node} lead @param {string} text */
const can = (lead, text) => h('li', {}, h('strong', {}, lead), sentenceGap(), text);
/** A Japanese word, marked as one, for a screen reader to say it right. @param {string} text */
const ja = (text) => h('span', { lang: 'ja', text });
/** Koe's and Kokoro's names in Japanese, 声 and 心: words of the welcome's, kept in every language. */
const KOE = /* en */ '声';
const KOKORO = /* en */ '心';

/** "annai's screens: English · Change" (localization design, section 2). */
function screensLine() {
  const name = ownName(lang());
  const change = t`Change`;
  return h('p', { class: 'sub' }, ...linkIn(t`annai's screens: ${name} · ${change}`, h('span', { lang: lang(), text: name }), h('a', { href: '#/shiori', text: change })));
}

/** @param {number} n @param {any} ctx @param {Element | null} ticks the free search services, ticked as saved (the search step) @returns {any[]} */
function body(n, ctx, ticks) {
  const id = idOf(n);
  if (id === 'welcome') {
    return [
      h('p', { class: 'lead', text: t`annai is a free, open-source travel guide that lives on your phone.` }),
      h('p', { text: t`Its guide is Shiori. She plans the trip with you, keeps your bookings and notes, reminds you at the right time and place, talks with you on the road, and makes a recap afterwards.` }),
      h('p', { class: 'sub', text: t`She is at the bottom of every screen: tap her to talk, or type.` }),
      h('p', { class: 'sub', text: t`annai (案内) is Japanese for "guidance; showing someone around".` }),
      SHIPPED.length > 1 ? screensLine() : null,
    ];
  }
  if (id === 'halves') {
    // The architecture, plainly (the user, 2026-10-23: "explain who is shiori, what is kokoro and what is koe").
    return [
      h('p', { class: 'lead', text: t`Shiori is your guide. She has two halves that work together.` }),
      h('ul', { class: 'can' },
        can(h('span', {}, ...linkIn(t`Koe (${KOE}, voice)`, ja(KOE))), t`talks with you and answers at once.`),
        can(h('span', {}, ...linkIn(t`Kokoro (${KOKORO}, heart and mind)`, ja(KOKORO))), t`thinks things through and does the work: planning, searching, reading your bookings.`)),
      h('p', { class: 'sub', text: t`You only talk to Shiori. While Kokoro works, Koe keeps you company, and tells you when Kokoro has the answer. What they tell each other shows in the conversation; Settings → Shiori can hide it.` }),
    ];
  }
  if (id === 'can') {
    return [h('ul', { class: 'can' },
      can(t`Plans and bookings.`, t`Plan the trip day by day with Shiori, and add your confirmations: PDFs, Wallet passes, screenshots. You book; annai never books for you.`),
      can(t`GPS.`, t`With GPS on, annai follows where you are and reminds you at the right time and place: when to leave, when you've arrived, when you're running late.`),
      can(t`Voice.`, t`Talk with Shiori hands-free, in the car or on a trail.`),
      can(t`Offline places.`, t`OpenStreetMap places, Wikipedia summaries and Wikivoyage guides along your plan, for when there's no signal.`),
      can(t`Photos.`, t`Show Shiori what you see, and ask about it.`),
      can(t`Backups.`, t`Export a file, or back up automatically to GitHub, a Forgejo or Gitea server, an S3 bucket or a WebDAV folder.`),
      can(t`Plugins and MCP servers.`, t`Skills, tools and screens that others make.`),
      can(t`Recap and replay.`, t`Afterwards, a recap of the trip, and its route played back.`))];
  }
  if (id === 'keys') return [h('p', { class: 'lead', text: t`annai is built so your keys and data stay yours. Here is exactly how, and where that stops.` }), ...keysAndData('h2')];
  if (id === 'fine') return finePrint();
  if (id === 'search') {
    return [
      h('p', { class: 'lead', text: t`Shiori can search the web as soon as you start, through free services. No key, nothing to set up.` }),
      h('p', { text: t`These are on. Untick any you would rather not use.` }),
      ticks,
      h('p', { class: 'sub', text: WELCOME_SEARCH }),
    ];
  }
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
    lead.textContent = sentences(inSafari() ? t`Connect a model there, so Shiori can think.` : t`Connect a model, so Shiori can think.`, featured, inSafari() ? t`A model set up here, in Safari, stays in Safari.` : '');
  };
  say('');
  Promise.all([officialPlugins(), ctx.llm.config()]).then(([list, cfg]) => {
    const f = list.find((x) => typeof x.featured === 'string' && x.featured);
    if (f && !Object.keys(cfg.providers).length) say(String(f.featured));
  }, () => {});
  if (!inSafari()) readyFeatured(ctx).catch(() => {});
  const model = [lead];
  if (isStandalone() || p === 'desktop') {
    return [...model, ...(p === 'desktop' && !isStandalone() ? [h('p', { class: 'sub', text: t`You can also install annai as an app from your browser's menu.` })] : [])];
  }
  const steps = INSTALL_STEPS[p];
  return [
    h('h2', { class: 'section', text: t`First, install annai` }),
    h('p', {
      text: p === 'ios'
        ? t`Safari can erase what annai keeps after 7 days without a visit, and the Home Screen app keeps data of its own. Add annai to your Home Screen, and set up your model there.`
        : t`Your browser may clear what annai keeps when space runs low. Install annai to keep your trips safe.`,
    }),
    h('ol', { class: 'steps' }, ...steps.map((s) => h('li', { text: s }))),
    // Only Chrome on Android offers to install from a button; Safari has none.
    p === 'android' ? h('div', { class: 'acts' }, installButton()) : null,
    h('h2', { class: 'section', text: p === 'ios' ? t`Then, in the Home Screen app` : t`Then` }),
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
      h('button', { class: 'btn pri', type: 'button', onclick: go(stepHash(n + 1)) }, t`Next`),
      n > 1 ? h('button', { class: 'btn', type: 'button', onclick: go(stepHash(n - 1)) }, t`Back`) : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: go(stepHash(LAST)) }, t`Skip`),
    ]
    // In Safari on an iPhone the model belongs in the Home Screen app, so looking around comes first there.
    : [
      ...(inSafari()
        ? [h('button', { class: 'btn pri', type: 'button', onclick: go('#/trips') }, t`Look around first`),
          h('button', { class: 'btn', type: 'button', onclick: go('#/models') }, t`Set up a model`)]
        : [h('button', { class: 'btn pri', type: 'button', onclick: go('#/models') }, t`Set up a model`),
          h('button', { class: 'btn', type: 'button', onclick: go('#/trips') }, t`Look around first`)]),
      h('button', { class: 'btn ghost', type: 'button', onclick: go(stepHash(n - 1)) }, t`Back`),
    ];
  const screen = h('div', { class: 'screen welcome', dataset: { step: String(n) } },
    h('p', { class: 'step', text: t`${num(n)} of ${num(LAST)}` }),
    title,
    ...body(n, ctx, idOf(n) === 'search' ? await freeTicks(ctx.ws) : null),
    h('div', { class: 'acts' }, ...nav));
  // Once the shell has put the step on screen, its heading takes the focus, so a screen reader starts there.
  setTimeout(() => { if (title.isConnected) title.focus(); }, 0);
  return screen;
}
