import { h, whenGone, t } from '../dom.js';
import { readAppSettings } from '../../core/settings.js';
import { shownSettings } from '../../core/shown.js';
import { renderCard, cardWho, cardKind } from '../cards.js';
import { costs } from '../../core/agent/budgets.js';
import { storedTexts } from '../../core/agent/log.js';
import { blobBytes } from '../../core/reach.js';
import { openPhotoViewer } from '../photo-viewer.js';
import { undoTuning } from '../../core/agent/personalities.js';
import { formatCost, wording, mark, sentences, sentenceGap, list as listed } from '../format.js';
import { ask } from '../ask.js';
import { ME } from '../../core/scopes.js';
import { onTap } from '../dock-hides.js';

/** How long a heard line waits for more of its words before it is announced, once (Gemini revises them as it hears). */
const HEARD_MS = 600;
const SHOWN = ['msg.user', 'heard', 'heard.text', 'out.speak', 'out.show', 'out.ask', 'grounded', 'tool.result', 'wake', 'compaction', 'error', 'paused', 'reminder', 'note', 'halves'];
/** Wakes that are lines of their own: the user's, typed or heard, and what the halves tell each other. */
const NOT_WOKE = ['user', 'choice', 'heard', 'note', 'cue', 'halves'];
/** Where a message puts a line's words, a node of their own: its translation places them where its language does (around). */
const WORDS = '\uE000';
/** A message holding WORDS, as the words before them, the node, and the words after. @param {string} message @param {Node | string} node @returns {[string, Node | string, string]} */
const around = (message, node) => {
  const [before, after = ''] = message.split(WORDS);
  return [before, node, after];
};

/**
 * What the announcer says of a line: her lines read "Shiori: …" (a plugin's kind of card, "Shiori (Trail): …"; a question,
 * "Shiori asks: …"), with the choices a card or a question offers read after the words, as her spoken lines always did, rather
 * than her label run into the words. A card with nothing to read says what it is. Nothing for what you typed or the halves'
 * notes; any other line as written.
 * @param {string} type the event's @param {string} kind a plugin's kind of card, by the name its plugin gave it, else ''
 * @param {string} words the line's words without its label @param {string[]} [choices] buttons that answer it
 * @param {{ image?: unknown }} [card] the card, for one with no words
 */
export const announcement = (type, kind, words, choices = [], card = {}) => announced(type, kind, words, choices, card).join('');

/** The same in three parts: annai's label, the words, and the choices that follow. Only the words can carry a language. @param {string} type @param {string} kind @param {string} words @param {string[]} [choices] @param {{ image?: unknown }} [card] */
export function announced(type, kind, words, choices = [], card = {}) {
  if (type === 'msg.user' || type === 'note') return ['', '', ''];
  if (type !== 'out.speak' && type !== 'out.show' && type !== 'out.ask') return ['', words, ''];
  const said = words || (type === 'out.show' ? (card.image ? t`a photo` : t`a card`) : '');
  const pick = choices.length ? `${sentenceGap()}${t`Choices: ${listed(choices, 'plain')}.`}` : '';
  const [before, , after] = around(type === 'out.ask' ? t`Shiori asks: ${WORDS}` : kind ? t`Shiori (${kind}): ${WORDS}` : t`Shiori: ${WORDS}`, '');
  return [before, said, `${after}${pick}`];
}

/** The words in a node, each piece of text apart, but those inside what a selector names. @param {HTMLElement} root @param {string} skip */
const textOf = (root, skip) => {
  /** @type {string[]} */
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text && !n.parentElement?.closest(skip)) out.push(text);
  }
  return out.join(' ');
};

/** A line's words as plain text, its blocks apart. @param {HTMLElement} node */
const plain = (node) => (node.innerText ?? node.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * The copy a photo ended up as, following its replacements (each refused copy names the next).
 * @param {string} hash @param {Map<string, { new: string }>} replaced
 */
export function latestCopy(hash, replaced) {
  let h = hash;
  for (let i = 0; i < 10 && replaced.has(h); i++) {
    const d = /** @type {any} */ (replaced.get(h));
    h = d.new ?? d.was?.new;
  }
  return h;
}

/** Each refused copy's replacement, by the refused copy's hash (one an import didn't carry is in data.was, spec §12.3). @param {any[]} events photo.replace entries */
export function replacements(events) {
  return new Map(events.map((e) => [e.data?.old ?? e.data?.was?.old, e.data]));
}

/**
 * Why Shiori woke, in the screens' words: made from each reason's kind (and a plugin's name), never from the words the model was
 * given for it, which are English and hers (the localization design, "Store data, not words"). Each kind is said once.
 * @param {{ kind: string, plugin?: string, text?: string }[]} reasons the wake's, but the lines of their own (NOT_WOKE); their text is the model's, unread here
 * @param {(id: string) => string} [nameOf] a plugin's name
 */
export function wokeText(reasons, nameOf = (id) => id) {
  /** @type {Record<string, string>} */
  const WHY = {
    file: t`Shiori woke to look at the files you added.`,
    restart: t`Shiori woke to pick up where she left off.`,
    personality: t`Shiori woke to merge a new version of her personality.`,
    trigger: t`Shiori woke for a reminder, or something she watches for.`,
    'catch-up': t`Shiori woke to catch up on what happened while annai was out of sight.`,
    live: t`Shiori woke because you turned GPS on.`,
    recap: t`Shiori woke to tell you the recap.`,
  };
  const said = new Set(reasons.map((r) => (r.kind === 'plugin' ? t`Shiori woke for the plugin ${nameOf(String(r.plugin ?? ''))}.` : WHY[r.kind] ?? t`Shiori woke.`)));
  return sentences(...said);
}

/**
 * A reminder annai showed by itself, from its data: the words before and after its text. The one title annai gives one is
 * "Shiori's answer" (her note shown for her, halves.js); anything else is a reminder. Said aloud, it says so. @param {{ title?: string, aloud?: boolean }} d
 * @returns {[string, string]}
 */
export function reminderLine(d) {
  const message = d.title === /* en */ "Shiori's answer" ? (d.aloud ? t`Shiori's answer, said aloud: ${WORDS}` : t`Shiori's answer: ${WORDS}`) : d.aloud ? t`Reminder, said aloud: ${WORDS}` : t`Reminder: ${WORDS}`;
  const [before, , after] = around(message, '');
  return [before, after];
}

/**
 * A reminder's line, for the Conversation and Now: its label from its data, then its words, marked. A plan watch's words are annai's
 * English as stored; anyone else's carry their own language. @param {any} d the event's data @param {(text: string) => Record<string, any>} mine
 */
export function reminderParts(d, mine) {
  const words = String(d.text ?? '');
  const [before, after] = reminderLine(d);
  return [before, h('span', { ...(String(d.watch ?? '').startsWith('plan:') ? { lang: 'en' } : mine(words)), text: words }), after];
}

/** Whose search grounded a reply: the name it gave, Google Search's by default. @param {any} d */
const sourceOf = (d) => String(d?.source || /* en */ 'Google Search');

/**
 * A reply grounded in Google Search, as Google gave it (G4; Google's terms): its words untouched, its links (web addresses
 * only, the loop's), and Google's suggestions in a frame sandboxed without allow-same-origin, which gets them by message.
 * Shown whatever the halves' toggle says. @param {any} d @param {Record<string, any>} texts @param {ReturnType<typeof wording>} say
 */
function groundedCard(d, texts, say) {
  const links = /** @type {{ url: string, title?: string }[]} */ (Array.isArray(d.links) ? d.links : []);
  const html = String(texts.html ?? '');
  const frame = html ? h('iframe', { class: 'suggestions', src: '/src/ui/grounding.html', title: t`Search suggestions from Google`, sandbox: /* en */ 'allow-scripts allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' }) : null;
  // Its one page, once: a frame that loads again (Google's HTML refreshing it, say) goes.
  let loads = 0;
  frame?.addEventListener('load', () => (loads++ ? frame.remove() : frame.contentWindow?.postMessage({ html }, '*')));
  return h('li', { class: 'shiori grounded' },
    h('strong', { class: 'card-title', text: t`From ${sourceOf(d)}` }),
    texts.text ? h('p', { ...say(String(texts.text)), text: String(texts.text) }) : null,
    links.length ? h('ul', { class: 'sources' }, ...links.map((l) => h('li', {}, h('a', { ...say(l.title ?? ''), href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.title || l.url })))) : null,
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
  // What Shiori's halves tell each other shows, and her spoken lines show their words, unless Settings say not (spec §16.1).
  const app = await readAppSettings(ctx.ws);
  const { showWords, showHalves: halves } = shownSettings(app);
  // The lines' languages (`lang`): the font and the screen reader's voice follow them. The user's by their text; Shiori's by the language she is set to answer in, else by her text.
  const mine = wording(app);
  const hers = wording(app, true);
  const scope = agent.scope;
  const title = agent.trip ? (await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ tx) => tx.getScope(agent.trip)))?.title ?? t`Trip` : '';
  // Not a live region: `announce` says each line of hers once, spoken or not, whatever "Show what she says" is, and words heard once
  // they are in; never what you typed, nor the halves' notes.
  const list = h('ol', { class: 'convo' });
  const announce = h('div', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const tell = (/** @type {string[]} */ [before, said, after], /** @type {string | undefined} */ lang) => { if (built && (before || said)) announce.replaceChildren(h('span', {}, before, h('span', { lang }, said), after)); };
  /** Heard lines announced, and those waiting HEARD_MS for more words: each is announced once, as its last revision. @type {Map<string, any>} */
  const hearing = new Map();
  /** @param {string} id @param {HTMLElement} words */
  const hearSoon = (id, words) => {
    if (!built || hearing.get(id) === true) return;
    clearTimeout(hearing.get(id));
    hearing.set(id, setTimeout(() => {
      hearing.set(id, true);
      tell(/** @type {string[]} */ (around(words.closest('.system-line') ? t`Heard, not for Shiori: ${WORDS}` : t`Heard: ${WORDS}`, words.textContent ?? '')), mine(words.textContent ?? '').lang);
    }, HEARD_MS));
  };
  const cost = h('p', { class: 'sub' });
  const showCost = async () => {
    const c = await costs(ctx.store, scope);
    cost.textContent = agent.trip ? t`This trip so far: ${formatCost(c.total)}` : t`This conversation so far: ${formatCost(c.total)}`;
  };
  /** @type {Map<string, HTMLElement>} asks still open, by call id */
  const asks = new Map();
  /** The newest error note with a Try again: it goes when anything newer joins the conversation. @type {{ li: HTMLElement, again: HTMLElement } | null} */
  let retry = null;
  /** Words heard, with the language they are in. @param {HTMLElement} span @param {string} text */
  const heardAs = (span, text) => {
    span.textContent = text;
    mark(span, mine(text));
  };
  /** @type {Map<string, HTMLElement>} heard lines' words, by id: written down, or ending, later (heard.text) */
  const unheard = new Map();
  // A refused photo's copy is replaced (spec §4.8): your bubble shows the copy Shiori was sent in the end.
  const replaced = replacements(await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ tx) => tx.listEvents(scope, { types: ['photo.replace'] })));
  /** @type {string[]} the photos' addresses, whose memory goes with the screen */
  const urls = [];
  /** The photos the user sent, as Shiori was sent them, read for this conversation (reach.js); a tap opens one full size. @param {any} e their message */
  const sentPhotos = async (e) => {
    const out = [];
    for (const im of Array.isArray(e.data?.images) ? e.data.images : []) {
      const copy = latestCopy(String(im?.hash ?? ''), replaced);
      // As sent: read through the message that names it; a later copy, through the conversation.
      const bytes = await blobBytes(ctx.store, scope, copy, copy === im?.hash ? { named: e } : { quiet: true });
      if (!bytes) continue;
      const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (bytes)], { type: String(im.mediaType ?? 'image/webp') }));
      urls.push(url);
      const label = String(im.path ?? t`A photo you sent`);
      out.push(h('button', { class: 'photo', type: 'button', 'aria-label': t`Open the photo full size`, onclick: () => openPhotoViewer(url, label) },
        h('img', { src: url, alt: t`A photo you sent`, title: label })));
    }
    return out;
  };
  /** @param {any} e */
  const item = async (e) => {
    const d = e.data ?? {};
    const texts = { ...d, ...(await storedTexts(ctx.store, e)) };
    if (e.type === 'msg.user') return h('li', { class: 'you' }, h('p', { ...mine(texts.text ?? ''), text: texts.text ?? '' }), ...(await sentPhotos(e)));
    if (e.type === 'out.speak') {
      const said = String(texts.text ?? '');
      if (!d.voice) return h('li', { class: 'shiori' }, h('span', { class: 'who', text: t`Shiori` }), h('p', { ...hers(said), text: said }));
      // Said aloud: its words show like any of hers, marked; with "Show what she says" off, they fold away until asked (spec §2 principle 4, §16.1).
      if (showWords) return h('li', { class: 'shiori said' }, h('span', { class: 'who-row' }, h('span', { class: 'who', text: t`Shiori` }), h('span', { class: 'sub said-mark', text: t`said aloud` })), h('p', { ...hers(said), class: 'said-words', text: said }));
      const words = h('p', { ...hers(said), text: said, hidden: true });
      const show = h('button', {
        class: 'btn ghost', type: 'button', 'aria-expanded': 'false',
        onclick: () => {
          words.hidden = !words.hidden;
          show.setAttribute('aria-expanded', String(!words.hidden));
          show.textContent = words.hidden ? t`Show what she said` : t`Hide`;
        },
      }, t`Show what she said`);
      return h('li', { class: 'shiori said' }, h('span', { class: 'who', text: t`Shiori` }), h('span', { class: 'sub', text: t`Said aloud` }), show, words);
    }
    if (e.type === 'heard') {
      // What annai heard you say, so you can see what it understood (spec §10.3).
      const words = h('span', {});
      heardAs(words, typeof d.text === 'string' ? d.text : '…');
      unheard.set(d.id, words); // its words may come later, or end later (Gemini's input transcript): heard.text
      return d.dismissed ? h('li', { class: 'system-line' }, ...around(t`Heard, not for Shiori: ${WORDS}`, words)) : h('li', { class: 'you heard' }, h('p', {}, words));
    }
    if (e.type === 'heard.text') {
      const words = unheard.get(d.of);
      if (words) {
        heardAs(words, String(d.text ?? ''));
        hearSoon(d.of, words);
      }
      return null;
    }
    if (e.type === 'out.show') {
      const card = renderCard(d.card ?? {}, { ctx, onChoice: (o) => agent.send(o), say: hers });
      const undo = d.tune ? tuneUndo(ctx, d.tune) : null;
      return h('li', { class: 'shiori' }, h('span', { class: 'who', text: cardWho(ctx, d.card ?? {}) }), card, undo);
    }
    if (e.type === 'grounded') return groundedCard(d, texts, mine); // Google's words: by their script alone, not the language she answers in
    if (e.type === 'out.ask') {
      const buttons = (Array.isArray(d.options) ? d.options : []).slice(0, 6).map((/** @type {string} */ o) => h('button', { ...hers(String(o)), class: 'btn', type: 'button', onclick: () => agent.answer(d.id, o) }, String(o)));
      const node = h('li', { class: 'shiori' }, h('span', { class: 'who', text: t`Shiori` }), h('p', { ...hers(String(d.question ?? '')), text: String(d.question ?? '') }), h('div', { class: 'acts' }, ...buttons));
      asks.set(d.id, node);
      return node;
    }
    if (e.type === 'tool.result' && asks.has(d.id)) {
      for (const b of asks.get(d.id)?.querySelectorAll('button') ?? []) /** @type {HTMLButtonElement} */ (b).disabled = true;
      asks.delete(d.id);
      return null;
    }
    if (e.type === 'reminder') {
      return h('li', { class: 'system-line' }, ...reminderParts(d, mine));
    }
    // What the halves tell each other, set apart from her reminders; annai's own blocks to them stay in the Trace.
    if (e.type === 'note') return halves ? h('li', { class: 'halves-note' }, h('strong', { text: d.from === 'koe' ? t`Koe to Kokoro:` : t`Kokoro to Koe:` }), sentenceGap(), h('span', { ...hers(String(texts.text ?? '')), text: String(texts.text ?? '') })) : null;
    if (e.type === 'wake') {
      // Kokoro's wakes are its own: the conversation is Koe's. A watch's wake says a lot, for Shiori: the line is cut.
      if (d.half === 'kokoro') return null;
      const others = (d.reasons ?? []).filter((/** @type {any} */ r) => !NOT_WOKE.includes(r.kind));
      return others.length ? h('li', { class: 'system-line', text: wokeText(others, (id) => String(ctx.plugins?.active?.get(id)?.manifest?.name ?? id)) }) : null;
    }
    // Made from its type: the words stored with it are the card's English.
    if (e.type === 'paused') return h('li', { class: 'system-line', text: t`Shiori was in the middle of something. She picks it up when you come back.` });
    // "Start fresh" leaves a divider: everything above stays to read, search and recall; she no longer carries it in mind.
    if (e.type === 'compaction' && d.mode === 'fresh') return h('li', { class: 'fresh-divider', text: t`Started fresh` }); // a list item with its words: a separator has no name
    if (e.type === 'compaction') return h('li', { class: 'system-line', text: t`Earlier conversation summarized. The full log is in Trace.` });
    // The other half told the user, in its own words, or Kokoro's while Koe talks (a card still says it).
    if (e.type === 'error' && (d.quiet || d.aside)) return null;
    if (e.type === 'error') {
      // Out of sight of the card at the page's top: the note itself offers Try again, until something newer is in the conversation.
      const again = d.kind === 'model' || d.kind === 'silent' ? h('button', { class: 'btn', type: 'button', onclick: (/** @type {Event} */ ev) => { /** @type {HTMLButtonElement} */ (ev.currentTarget).remove(); agent.tryAgain(); } }, t`Try again`) : null;
      // Its message is as stored: annai's English, or a provider's own words.
      const li = h('li', { class: 'system' }, h('strong', { text: d.kind === 'model' ? t`Shiori can't reach her model` : d.kind === 'budget' ? t`A budget ended her turn` : t`Her turn ended` }), h('p', { lang: 'en', text: String(d.message ?? '') }), again);
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
  const empty = h('p', { class: 'empty', text: t`Nothing yet. Tap Shiori or Type below to talk.` });
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
  for (const type of USER) addEventListener(type, own, { passive: true });
  const grows = new ResizeObserver(() => { if (following) scrollTo(0, document.documentElement.scrollHeight); });
  grows.observe(list);
  let built = false;
  let wasShown = false;
  const stop = await follow(agent, scope, {
    read: async () => (await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ tx) => tx.listEvents(scope, { types: SHOWN, reverse: true, limit: 400 }))).reverse(),
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
        if (e.type === 'heard') {
          const words = unheard.get(e.data?.id);
          if (words && typeof e.data?.text === 'string') hearSoon(e.data.id, words);
        } else {
          const who = node.querySelector('.who');
          // A plugin's kind of card is drawn by its plugin: the choices and the photo annai draws on its own cards are not on it.
          const kind = e.type === 'out.show' ? cardKind(ctx, e.data?.card) : '';
          const choices = (e.type === 'out.ask' ? e.data?.options : kind ? [] : e.data?.card?.choice);
          const pick = Array.isArray(choices) ? choices.slice(0, 6).map(String) : [];
          let words = plain(node);
          if (e.type === 'out.speak') words = node.querySelector('p')?.textContent ?? '';
          else if (e.type === 'out.ask') words = String(e.data?.question ?? '');
          else if (e.type === 'out.show') {
            // The card's own words, its blocks apart, without the label and the buttons that answer it (they are read as its choices).
            words = textOf(node, pick.length ? /* en */ '.who, .card .acts button' : '.who');
          }
          // Her words carry their language; annai's labels, errors and notes around and beside them do not.
          const parts = announced(e.type, kind, words, pick, kind ? {} : e.data?.card ?? {});
          if (e.type === 'grounded') {
            const [title, text] = [node.querySelector('strong')?.textContent ?? '', node.querySelector('p')?.textContent ?? ''];
            const rest = words.replace(title, '').replace(text, '').trim();
            tell([`${t`From ${sourceOf(e.data)}.`}${sentenceGap()}`, text, rest ? `${sentenceGap()}${rest}` : ''], mine(text).lang);
          } else tell(parts, ['out.speak', 'out.show', 'out.ask'].includes(e.type) ? hers(words).lang : undefined);
        }
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
  const screen = h('div', { class: 'screen' },
    h('h1', { class: 'title', text: t`Conversation` }),
    tidyMenu(ctx),
    h('p', { class: 'sub', text: agent.trip ? title : t`No trip is open. Open one from Trips, or talk here: Shiori can still use /me/.` }),
    cost,
    list.childElementCount ? null : empty,
    list,
    announce);
  requestAnimationFrame(() => {
    if (!list.isConnected) return; // another screen opened while this one was built: whenGone stops it
    wasShown = true;
    if (list.childElementCount) toEnd();
  });
  // Gone, it stops listening at once, and the photos it showed let their memory go.
  whenGone(screen, () => {
    stop();
    for (const timer of hearing.values()) clearTimeout(timer);
    removeEventListener('message', fit);
    for (const type of USER) removeEventListener(type, own);
    grows.disconnect();
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  });
  return screen;
}

/**
 * The Conversation screen's menu (the user, 2026-10-23: "some way to let the user compact or clear the transcript / session manually?"):
 * Summarize now, which runs housekeeping as it would run by itself, and Start fresh, which has Shiori start a new context from here.
 * Neither deletes a line: the earlier ones stay in the conversation, searchable and recallable (spec §6.5, §16.2).
 * @param {any} ctx
 */
function tidyMenu(ctx) {
  const agent = ctx.agent;
  const toggle = h('button', { class: 'btn ghost tidy-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'tidy-menu' }, t`Tidy up`);
  const menu = h('div', { id: 'tidy-menu', class: 'tidy-menu', role: 'group', 'aria-label': t`Tidy up the conversation`, hidden: true });
  const close = () => {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.addEventListener('click', () => {
    if (toggle.getAttribute('aria-disabled') === 'true') return;
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
  });
  const summarize = h('button', {
    class: 'btn', type: 'button', 'aria-describedby': 'tidy-summarize',
    onclick: async () => {
      close();
      ctx.notices.toast(t`Summarizing…`);
      const r = await agent.summarizeNow();
      ctx.notices.toast({ done: t`Earlier conversation summed up. Every line stays here, and she can still look them up.`, nothing: t`There is not enough yet to summarize.`, busy: t`Shiori is working. Try again in a moment.`, failed: t`She couldn't summarize it. A card says why.` }[/** @type {'done' | 'nothing' | 'busy' | 'failed'} */ (r)]);
      if (r === 'done') ctx.render();
    },
  }, t`Summarize now`);
  /** Start fresh runs: the toggle says so, and opens nothing meanwhile. @param {boolean} on */
  const working = (on) => {
    toggle.setAttribute('aria-busy', String(on));
    toggle.setAttribute('aria-disabled', String(on));
    toggle.textContent = on ? t`Starting fresh…` : t`Tidy up`;
  };
  const fresh = h('button', {
    class: 'btn', type: 'button', 'aria-describedby': 'tidy-fresh',
    onclick: async () => {
      close();
      const yes = await ask({
        title: t`Start fresh?`,
        body: t`Shiori will start over from here, without the earlier lines in mind. They all stay in the conversation, for you to read and search, and she can still look them up: nothing is deleted. A live voice session restarts too.`,
        yes: t`Start fresh`,
      });
      if (!yes) return void toggle.focus();
      working(true);
      /** @type {import('../../core/agent/loop.js').Fresh} */
      let r;
      try {
        r = await agent.startFresh();
      } catch (e) {
        working(false);
        ctx.notices.toast(t`She couldn't start fresh: ${String(/** @type {any} */ (e)?.message ?? e)}`);
        return void toggle.focus();
      }
      ctx.notices.toast({ done: t`Started fresh.`, nothing: t`There is nothing to start fresh from yet.`, already: t`Already fresh: nothing has been said since.`, opening: t`The conversation is still opening. Try again in a moment.` }[r]);
      if (r !== 'done') {
        working(false);
        return void toggle.focus();
      }
      await ctx.render();
      /** @type {HTMLElement | null} */ (document.querySelector('.tidy-toggle'))?.focus(); // the new screen's, after the divider
    },
  }, t`Start fresh`);
  // A tap elsewhere closes it, never at its press: nothing moves under a finger still down.
  const offTap = onTap((at) => { if (!menu.hidden && !menu.contains(/** @type {Node} */ (at)) && at !== toggle) close(); });
  // Escape closes it wherever the focus is (Safari doesn't focus a button on a tap).
  const escape = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    close();
    toggle.focus();
  };
  document.addEventListener('keydown', escape);
  const el = h('div', { class: 'tidy' }, toggle, menu);
  menu.append(
    h('p', { id: 'tidy-summarize', class: 'sub', text: t`Summarize now: Shiori sums up the earlier conversation now, to keep it short. Every line stays here, and she can still look them up.` }), summarize,
    h('p', { id: 'tidy-fresh', class: 'sub', text: t`Start fresh: Shiori puts the earlier lines out of mind and starts over from here. Every line stays here, above a divider.` }), fresh);
  whenGone(el, () => {
    offTap();
    document.removeEventListener('keydown', escape);
  });
  return el;
}

/**
 * The Undo under a "I adjusted my personality" card. Once done it says so and offers no second Undo; a card for a change that is
 * already back as it was (undone before, or put back by hand) says so from the start (the second emulator re-check).
 * @param {any} ctx @param {{ name: string, old: string | null }} tune
 */
function tuneUndo(ctx, tune) {
  const el = h('span', {});
  const done = () => el.replaceChildren(h('span', { class: 'sub', role: 'status', text: t`Undone` }));
  const button = h('button', {
    class: 'btn ghost', type: 'button',
    onclick: async () => {
      button.disabled = true;
      try {
        await undoTuning(ctx.ws, tune.name, /** @type {string} */ (tune.old));
        ctx.notices.toast(t`Undone. Her old personality applies at her next wake.`);
        done();
      } catch (e) {
        button.disabled = false;
        ctx.notices.toast(String(/** @type {any} */ (e)?.message ?? e));
      }
    },
  }, t`Undo`);
  el.append(button);
  if (tune.old) ctx.ws.read(ME, /* en */ `/personalities/${tune.name}.md`).then((/** @type {any} */ now) => { if (now?.entry.hash === tune.old) done(); }, () => {});
  return el;
}
