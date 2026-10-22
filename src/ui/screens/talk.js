import { h, whenGone, checkbox } from '../dom.js';
import { renderCard, cardWho } from '../cards.js';
import { costs } from '../../core/agent/budgets.js';
import { storedTexts, blobBytes } from '../../core/agent/log.js';
import { openPhotoViewer } from '../photo-viewer.js';
import { undoTuning } from '../../core/agent/personalities.js';
import { formatCost } from '../format.js';
import { ME } from '../../core/scopes.js';

const SHOWN = ['msg.user', 'heard', 'heard.text', 'out.speak', 'out.show', 'out.ask', 'grounded', 'tool.result', 'wake', 'compaction', 'error', 'paused', 'reminder', 'note', 'halves'];
/** Wakes that are lines of their own: the user's, and what the halves tell each other. */
const NOT_WOKE = ['user', 'choice', 'note', 'cue', 'halves'];
const HALVES_KEY = 'annai.showHalves';

/** Whether this device shows what Shiori's halves tell each other (off unless asked); for this visit where storage is blocked. */
let halvesHere = false;
function showingHalves() {
  try {
    return localStorage.getItem(HALVES_KEY) === '1';
  } catch {
    return halvesHere;
  }
}

/**
 * The copy a photo ended up as, following its replacements (each refused copy names the next).
 * @param {string} hash @param {Map<string, { new: string }>} replaced
 */
export function latestCopy(hash, replaced) {
  let h = hash;
  for (let i = 0; i < 10 && replaced.has(h); i++) h = /** @type {{ new: string }} */ (replaced.get(h)).new;
  return h;
}

/**
 * A reply grounded in Google Search, as Google gave it (G4; Google's terms): its words untouched, its links (web addresses
 * only, the loop's), and Google's suggestions in a frame sandboxed without allow-same-origin, which gets them by message.
 * Shown whatever the halves' toggle says. @param {any} d @param {Record<string, any>} texts
 */
function groundedCard(d, texts) {
  const links = /** @type {{ url: string, title?: string }[]} */ (Array.isArray(d.links) ? d.links : []);
  const html = String(texts.html ?? '');
  const frame = html ? h('iframe', { class: 'suggestions', src: '/src/ui/grounding.html', title: 'Search suggestions from Google', sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' }) : null;
  // Its one page, once: a frame that loads again (Google's HTML refreshing it, say) goes.
  let loads = 0;
  frame?.addEventListener('load', () => (loads++ ? frame.remove() : frame.contentWindow?.postMessage({ html }, '*')));
  return h('li', { class: 'shiori grounded' },
    h('strong', { class: 'card-title', text: `From ${String(d.source || 'Google Search')}` }),
    texts.text ? h('p', { text: String(texts.text) }) : null,
    links.length ? h('ul', { class: 'sources' }, ...links.map((l) => h('li', {}, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.title || l.url })))) : null,
    frame);
}

/**
 * Shows a conversation's events in order, missing none: it listens before it reads, so an event
 * that comes while the log is read (or while those are shown) is shown once, after them. While the
 * screen is being built events are still shown; once it has left the page, it stops listening.
 * @param {{ on: (kind: 'event', fn: (e: any) => void) => () => void }} agent @param {string} scope
 * @param {{ read: () => Promise<any[]>, show: (e: any) => Promise<void>, state: () => 'building' | 'shown' | 'gone' }} o
 * @returns {Promise<() => void>} stops listening
 */
export async function follow(agent, scope, { read, show, state }) {
  let last = 0;
  /** @type {any[] | null} what came while the log was read */
  let early = [];
  const one = (/** @type {any} */ e) => {
    if (e.scope !== scope || !(e.seq > last)) return null;
    last = e.seq;
    return show(e);
  };
  const off = agent.on('event', (e) => {
    if (state() === 'gone') {
      off();
      return;
    }
    if (early) early.push(e);
    else one(e);
  });
  for (const e of await read()) await one(e);
  for (const e of early) await one(e); // more may come meanwhile: they are shown here too
  early = null;
  return off;
}

/**
 * The conversation (spec §16.2): what the user wrote, what Shiori said and showed, her questions,
 * and system cards. Her private text and reasoning stay in the trace (§7.1).
 * @param {any} ctx
 */
export async function renderTalk(ctx) {
  const agent = ctx.agent;
  await agent.opening.catch(() => {}); // after a start or a trip change, the conversation is still being read
  // Shiori as two halves (the Koe and Kokoro design): their exchanges stay out of the conversation unless asked.
  const halves = showingHalves();
  let split = Boolean(agent.koeState && agent.koeState !== 'off');
  const scope = agent.scope;
  const title = agent.trip ? (await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(agent.trip)))?.title ?? 'Trip' : 'No trip open';
  const list = h('ol', { class: 'convo', 'aria-live': 'polite' });
  const cost = h('p', { class: 'sub' });
  const showCost = async () => {
    const c = await costs(ctx.store, scope);
    cost.textContent = `${agent.trip ? 'This trip' : 'This conversation'} so far: ${formatCost(c.total)}`;
  };
  /** @type {Map<string, HTMLElement>} asks still open, by call id */
  const asks = new Map();
  /** The newest error note with a Try again: it goes when anything newer joins the conversation. @type {{ li: HTMLElement, again: HTMLElement } | null} */
  let retry = null;
  /** @type {Map<string, HTMLElement>} heard speech whose words are still being written down */
  const unheard = new Map();
  // A refused photo's copy is replaced (spec §4.8): your bubble shows the copy Shiori was sent in the end.
  const replaced = new Map((await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['photo.replace'] })))
    .map((/** @type {any} */ e) => [e.data?.old, e.data]));
  /** @type {string[]} the photos' addresses, whose memory goes with the screen */
  const urls = [];
  /** The photos the user sent, as Shiori was sent them; a tap opens one full size. @param {any} images */
  const sentPhotos = async (images) => {
    const out = [];
    for (const im of Array.isArray(images) ? images : []) {
      const bytes = await blobBytes(ctx.store, latestCopy(String(im?.hash ?? ''), replaced));
      if (!bytes) continue;
      const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (bytes)], { type: String(im.mediaType ?? 'image/webp') }));
      urls.push(url);
      const label = String(im.path ?? 'A photo you sent');
      out.push(h('button', { class: 'photo', type: 'button', 'aria-label': 'Open the photo full size', onclick: () => openPhotoViewer(url, label) },
        h('img', { src: url, alt: 'A photo you sent', title: label })));
    }
    return out;
  };
  /** @param {any} e */
  const item = async (e) => {
    const d = e.data ?? {};
    const texts = { ...d, ...(await storedTexts(ctx.store, e)) };
    if (e.type === 'msg.user') return h('li', { class: 'you' }, h('p', { text: texts.text ?? '' }), ...(await sentPhotos(d.images)));
    if (e.type === 'out.speak') {
      if (!d.voice) return h('li', { class: 'shiori' }, h('span', { class: 'who', text: 'SHIORI' }), h('p', { text: texts.text ?? '' }));
      // Said aloud: hidden unless asked (spec §2 principle 4, §16.1).
      const words = h('p', { text: texts.text ?? '', hidden: true });
      const show = h('button', {
        class: 'btn ghost', type: 'button', 'aria-expanded': 'false',
        onclick: () => {
          words.hidden = !words.hidden;
          show.setAttribute('aria-expanded', String(!words.hidden));
          show.textContent = words.hidden ? 'Show what she said' : 'Hide';
        },
      }, 'Show what she said');
      return h('li', { class: 'shiori said' }, h('span', { class: 'who', text: 'SHIORI' }), h('span', { class: 'sub', text: 'Said aloud' }), show, words);
    }
    if (e.type === 'heard') {
      // What annai heard you say, so you can see what it understood (spec §10.3).
      const words = h('span', { text: typeof d.text === 'string' ? d.text : '…' });
      if (typeof d.text !== 'string') unheard.set(d.id, words);
      return d.dismissed ? h('li', { class: 'system-line' }, 'Heard, not for Shiori: ', words) : h('li', { class: 'you heard' }, h('p', {}, words));
    }
    if (e.type === 'heard.text') {
      const words = unheard.get(d.of);
      if (words) words.textContent = String(d.text ?? '');
      unheard.delete(d.of);
      return null;
    }
    if (e.type === 'out.show') {
      const card = renderCard(d.card ?? {}, { ctx, onChoice: (o) => agent.send(o) });
      const undo = d.tune ? tuneUndo(ctx, d.tune) : null;
      return h('li', { class: 'shiori' }, h('span', { class: 'who', text: cardWho(ctx, d.card ?? {}) }), card, undo);
    }
    if (e.type === 'grounded') return groundedCard(d, texts);
    if (e.type === 'out.ask') {
      const buttons = (Array.isArray(d.options) ? d.options : []).slice(0, 6).map((/** @type {string} */ o) => h('button', { class: 'btn', type: 'button', onclick: () => agent.answer(d.id, o) }, String(o)));
      const node = h('li', { class: 'shiori' }, h('span', { class: 'who', text: 'SHIORI' }), h('p', { text: String(d.question ?? '') }), h('div', { class: 'acts' }, ...buttons));
      asks.set(d.id, node);
      return node;
    }
    if (e.type === 'tool.result' && asks.has(d.id)) {
      for (const b of asks.get(d.id)?.querySelectorAll('button') ?? []) /** @type {HTMLButtonElement} */ (b).disabled = true;
      asks.delete(d.id);
      return null;
    }
    if (e.type === 'reminder') return h('li', { class: 'system-line', text: `${d.title ?? 'Reminder'}${d.aloud ? ', said aloud' : ''}: ${String(d.text ?? '')}` });
    if (e.type === 'note' || e.type === 'halves') {
      split = true;
      if (!halves) return null;
      const who = e.type === 'halves' ? 'annai to Kokoro' : d.from === 'koe' ? 'Koe to Kokoro' : 'Kokoro to Koe';
      return h('li', { class: 'system-line', text: `${who}: ${String(texts.text ?? '')}` });
    }
    if (e.type === 'wake') {
      // Kokoro's wakes are its own: the conversation is Koe's. A watch's wake says a lot, for Shiori: the line is cut.
      if (d.half === 'kokoro') return null;
      const others = (d.reasons ?? []).filter((/** @type {any} */ r) => !NOT_WOKE.includes(r.kind));
      const why = others.map((/** @type {any} */ r) => r.text).join('; ');
      return others.length ? h('li', { class: 'system-line', text: `Shiori woke: ${why.length > 160 ? `${why.slice(0, 160)}…` : why}` }) : null;
    }
    if (e.type === 'paused') return h('li', { class: 'system-line', text: String(d.text ?? '') });
    if (e.type === 'compaction') return h('li', { class: 'system-line', text: 'Earlier conversation summarized. The full log is in Trace.' });
    // The other half told the user, in its own words, or Kokoro's while Koe talks (a card still says it).
    if (e.type === 'error' && (d.quiet || d.aside)) return null;
    if (e.type === 'error') {
      // Out of sight of the card at the page's top: the note itself offers Try again, until something newer is in the conversation.
      const again = d.kind === 'model' || d.kind === 'silent' ? h('button', { class: 'btn', type: 'button', onclick: (/** @type {Event} */ ev) => { /** @type {HTMLButtonElement} */ (ev.currentTarget).remove(); agent.tryAgain(); } }, 'Try again') : null;
      const li = h('li', { class: 'system' }, h('strong', { text: d.kind === 'model' ? "Shiori can't reach her model" : d.kind === 'budget' ? 'A budget ended her turn' : 'Her turn ended' }), h('p', { text: String(d.message ?? '') }), again);
      retry?.again.remove();
      retry = again ? { li, again } : null;
      return li;
    }
    return null;
  };
  // A suggestions frame says how tall it is (G4): only a number, only from one of this screen's frames.
  const fit = (/** @type {MessageEvent} */ e) => {
    const frame = /** @type {HTMLIFrameElement[]} */ ([...list.querySelectorAll('iframe.suggestions')]).find((f) => f.contentWindow === e.source);
    const px = Number(e.data?.height);
    if (frame && Number.isFinite(px)) frame.style.setProperty('height', `${Math.min(Math.max(Math.ceil(px), 0), 320)}px`);
  };
  addEventListener('message', fit);
  const empty = h('p', { class: 'empty', text: 'Nothing yet. Tap Shiori or Type below to talk.' });
  // The end of the conversation: the page's foot keeps its last words clear of the dock. Once there, it is followed, as a
  // photo loads or a frame takes its height too, until the user scrolls of their own accord (review S3).
  const atEnd = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 120;
  let following = false;
  const toEnd = () => {
    following = true;
    scrollTo(0, document.documentElement.scrollHeight);
  };
  const own = (/** @type {Event} */ e) => {
    const k = /** @type {KeyboardEvent} */ (e).key;
    if (e.type !== 'keydown' || (/^(Page|Arrow)(Up|Down)$|^(Home|End| )$/.test(k) && !/** @type {Element} */ (e.target).closest?.('input, textarea, select'))) following = false;
  };
  const USER = ['wheel', 'touchmove', 'keydown'];
  for (const t of USER) addEventListener(t, own, { passive: true });
  const grows = new ResizeObserver(() => { if (following) scrollTo(0, document.documentElement.scrollHeight); });
  grows.observe(list);
  let built = false;
  let wasShown = false;
  const stop = await follow(agent, scope, {
    read: async () => (await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: SHOWN, reverse: true, limit: 400 }))).reverse(),
    show: async (e) => {
      if (!SHOWN.includes(e.type)) return;
      // What the user just said is always followed; what comes after, while the user is at the end.
      const follow = built && (following || atEnd() || e.type === 'msg.user' || e.type === 'heard');
      const node = await item(e);
      if (node) {
        if (retry && node !== retry.li) {
          retry.again.remove();
          retry = null;
        }
        empty.remove();
        list.append(node);
        if (follow) toEnd();
        // A plugin's dock may have no avatar of annai's (fix pass 8b-2).
        if (built && e.actor === 'shiori') ctx.dock?.avatar?.glance?.(0, 1.5);
      }
      if (built) showCost();
    },
    state: () => {
      if (list.isConnected) wasShown = true;
      return list.isConnected ? 'shown' : wasShown ? 'gone' : 'building';
    },
  });
  built = true;
  showCost();
  const toggle = checkbox('Show what the halves tell each other', halves);
  toggle.input.addEventListener('change', () => {
    halvesHere = toggle.input.checked;
    try {
      localStorage.setItem(HALVES_KEY, halvesHere ? '1' : '0');
    } catch {
      // storage blocked: for this visit only
    }
    ctx.render();
  });
  const screen = h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Conversation' }),
    h('p', { class: 'sub', text: agent.trip ? title : 'No trip is open. Open one from Trips, or talk here: Shiori can still use /me/.' }),
    cost,
    list.childElementCount ? null : empty,
    list,
    split ? toggle.el : null);
  requestAnimationFrame(() => {
    if (!list.isConnected) return; // another screen opened while this one was built: whenGone stops it
    wasShown = true;
    if (list.childElementCount) toEnd();
  });
  // Gone, it stops listening at once, and the photos it showed let their memory go.
  whenGone(screen, () => {
    stop();
    removeEventListener('message', fit);
    for (const t of USER) removeEventListener(t, own);
    grows.disconnect();
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  });
  return screen;
}

/**
 * The Undo under a "I adjusted my personality" card. Once done it says so and offers no second Undo; a card for a change that is
 * already back as it was (undone before, or put back by hand) says so from the start (the second emulator re-check).
 * @param {any} ctx @param {{ name: string, old: string | null }} tune
 */
function tuneUndo(ctx, tune) {
  const el = h('span', {});
  const done = () => el.replaceChildren(h('span', { class: 'sub', role: 'status', text: 'Undone' }));
  const button = h('button', {
    class: 'btn ghost', type: 'button',
    onclick: async () => {
      button.disabled = true;
      try {
        await undoTuning(ctx.ws, tune.name, /** @type {string} */ (tune.old));
        ctx.notices.toast('Undone. Her old personality applies at her next wake.');
        done();
      } catch (e) {
        button.disabled = false;
        ctx.notices.toast(String(/** @type {any} */ (e)?.message ?? e));
      }
    },
  }, 'Undo');
  el.append(button);
  if (tune.old) ctx.ws.read(ME, `/personalities/${tune.name}.md`).then((/** @type {any} */ now) => { if (now?.entry.hash === tune.old) done(); }, () => {});
  return el;
}
