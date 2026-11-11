import { h, whenGone, t, tc, plural, linkIn, messageOf } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { shownSettings } from '../../core/shown.js';
import { shownCard, cardWho, cardKind } from '../cards.js';
import { costs, budgetWords } from '../../core/agent/budgets.js';
import { whyWords } from '../../core/llm/fallback.js';
import { tidyFailed, PHOTO_ONLY } from '../../core/agent/loop.js';
import { planWords } from '../../core/live/plan-watches.js';
import { storedTexts } from '../../core/agent/log.js';
import { blobBytes } from '../../core/reach.js';
import { herDatings, undoDating } from '../../core/chats.js';
import { openPhotoViewer } from '../photo-viewer.js';
import { undoTuning } from '../../core/agent/personalities.js';
import { formatCost, wording, mark, sentences, sentenceGap, list as listed, recordHref, waitingHref, rowName, talkHref } from '../format.js';
import { day } from '../../core/intl.js';
import { upcoming, over } from '../../core/now.js';
import { tripRows } from '../trip-rows.js';
import { nowOf, todayOf } from '../today.js';
import { ask } from '../ask.js';
import { ME, SYS_WAITING, scopeTitle, talks, tripMirror, kindOf } from '../../core/scopes.js';
import { readNames } from '../../core/names.js';
import { FILES_ONLY, undoable, undoEverywhere } from '../../core/handover.js';
import { removeTripNow } from './trip.js';
import { onTap } from '../dock-hides.js';
import { MOVED_MS } from '../notices.js';
import { openOrTell, openTrip, toTalk, talkOf } from '../open-trip.js';
import { parseHash } from '../router.js';
import { lineKind, lineClass, lineLabel, modelWords, kokorosWords } from '../line-kind.js';
import { NOT_TRANSCRIBED } from '../../core/voice/resolve.js';

/** How long a heard line waits for more of its words before it is announced, once (Gemini revises them as it hears). */
const HEARD_MS = 600;
const SHOWN = ['msg.user', 'heard', 'heard.text', 'out.speak', 'out.show', 'out.ask', 'grounded', 'tool.result', 'wake', 'compaction', 'error', 'paused', 'reminder', 'note', 'halves', 'handover.moved', 'handover.undo', 'trip.read', 'conversation.moved'];
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
 * What the announcer says of a line, in three parts: annai's label, the words, and the choices that follow. Only the words can carry a language.
 * Her lines read "Shiori: …" (a plugin's kind of card, "Shiori (Trail): …"; a question, "Shiori asks: …"), with any choices after the words.
 * A card with nothing to read says what it is. Nothing for what you typed or the halves' notes; any other line as written.
 * @param {string} type the event's @param {string} kind a plugin's kind of card, by the name its plugin gave it, else ''
 * @param {string} words the line's words without its label @param {string[]} [choices] buttons that answer it
 * @param {{ image?: unknown, own?: boolean }} [card] the card, for one with no words; own: a question that is annai's own (Agent.confirm)
 */
export function announced(type, kind, words, choices = [], card = {}) {
  if (type === 'msg.user' || type === 'note' || type.startsWith('handover.')) return ['', '', ''];
  if (type !== 'out.speak' && type !== 'out.show' && type !== 'out.ask') return ['', words, ''];
  const said = words || (type === 'out.show' ? (card.image ? t`a photo` : t`a card`) : '');
  const pick = choices.length ? `${sentenceGap()}${t`Choices: ${listed(choices, 'plain')}.`}` : '';
  const [before, , after] = around(type === 'out.ask' ? (card.own ? t`annai asks: ${WORDS}` : t`Shiori asks: ${WORDS}`) : kind ? t`Shiori (${kind}): ${WORDS}` : t`Shiori: ${WORDS}`, '');
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
 * Why Shiori woke, in the screens' words, from each reason's kind and data (files, what fired, a plugin), never the model's English
 * reason ("Store data, not words"). Each line once; an older wake, with no data, by its kind.
 * @param {{ kind: string, plugin?: string, text?: string, files?: string[], titles?: string[] }[]} reasons the wake's, but the lines of their own (NOT_WOKE); their text is the model's, unread here
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
  /** @param {(typeof reasons)[number]} r */
  const line = (r) => {
    const files = (r.kind === 'file' && r.files) || [];
    const titles = wokeTitles([r]);
    if (files.length > 3) return plural(files.length, 'Shiori woke to look at the file you added.', 'Shiori woke to look at the # files you added.');
    if (files.length) return plural(files.length, 'Shiori woke to look at the file you added: {0}.', 'Shiori woke to look at the # files you added: {0}.', listed(files.map((p) => p.split('/').pop() ?? p)));
    if (titles.length) return plural(titles.length, 'Shiori woke for a reminder, or something she watches for: {0}.', 'Shiori woke for # reminders, or things she watches for: {0}.', listed(titles));
    return r.kind === 'plugin' ? t`Shiori woke for the plugin ${nameOf(String(r.plugin ?? ''))}.` : WHY[r.kind] ?? t`Shiori woke.`;
  };
  return sentences(...new Set(reasons.map(line)));
}

/**
 * Where a hand-over's files went, from the entry's data (handover.moved): the trip she started or took them to, by its title, or one
 * since removed (title null). @param {{ to: string, started: boolean, count: number }} d @param {string | null} title
 */
export function movedWords(d, title) {
  if (title === null) return t`Shiori took these files to a trip that has since been removed.`;
  if (d.started) return d.count ? t`Shiori started ${title} with these files.` : t`Shiori started ${title}.`;
  return plural(d.count, 'Shiori took # file to {0}.', 'Shiori took # files to {0}.', title);
}

/** Where Shiori took the user from this conversation (conversation.moved), by the trip's title now, or one since removed (null). @param {string | null} title */
export const wentWords = (title) => (title === null ? t`Shiori moved this to a trip that has since been removed.` : t`Shiori moved this to ${title}.`);

/**
 * What Undo of a hand-over did (undoEverywhere's outcome): the trips it removed and where the files are, each other trip that stays that it
 * changed, and the files left as the user changed them.
 * @param {Awaited<ReturnType<typeof undoEverywhere>>} o
 */
export function undoneWords({ removed, kept, waiting, back, changed }) {
  const home = listed(back.map((b) => b.title));
  const said = removed.length
    ? waiting ? plural(removed.length, 'Undone. {0} is removed, and your files are waiting with Shiori.', 'Undone. {0} are removed, and your files are waiting with Shiori.', listed(removed))
      : back.length ? plural(removed.length, 'Undone. {0} is removed, and your files are back in {1}.', 'Undone. {0} are removed, and your files are back in {1}.', listed(removed), home)
        : plural(removed.length, 'Undone. {0} is removed.', 'Undone. {0} are removed.', listed(removed))
    : waiting ? t`Undone. Your files are waiting with Shiori again.` : back.length ? t`Undone. Your files are back in ${home}.` : t`Undone.`;
  return sentences(said, changed.length ? t`What Shiori did in ${listed(changed.map((c) => c.title))} is undone too.` : '',
    kept ? plural(kept, 'Left # file as you changed it.', 'Left # files as you changed them.') : '');
}

/**
 * Shiori's turn, settled: Undo tapped while she works stops her turn first and waits for it, so nothing she writes for the hand-over
 * lands after Undo has looked. @param {{ busy: boolean, stopKokoro?: () => void, idle: () => Promise<void> }} agent
 */
export async function settled(agent) {
  if (!agent.busy) return;
  agent.stopKokoro?.();
  await agent.idle();
}

/** What fired, each to be marked with its language; the line ends them. @param {{ kind: string, titles?: string[] }[]} reasons */
export const wokeTitles = (reasons) => reasons.flatMap((r) => (r.kind === 'trigger' && r.titles) || []).map((s) => s.replace(/[.!?。！？]+$/u, ''));

/**
 * A reminder annai showed by itself, for the Conversation and Now, from its data. Her note shown for her (halves.js) is "Shiori's answer", anything else a reminder.
 * A plan watch's words are made from its data, in the screens' language (an older one's are annai's English as stored, so marked). @param {any} d the event's data
 * @param {(text: string) => Record<string, any>} mine @param {(tag: string, attrs: Record<string, any>) => Node | string} [make] h, or a test's own
 */
export function reminderParts(d, mine, make = h) {
  const message = kokorosWords(d) ? (d.aloud ? t`Shiori's answer, said aloud: ${WORDS}` : t`Shiori's answer: ${WORDS}`) : d.aloud ? t`Reminder, said aloud: ${WORDS}` : t`Reminder: ${WORDS}`;
  return around(message, reminderWords(d, mine, make));
}

/** A reminder's words alone, marked with their language. @param {any} d the event's data @param {(text: string) => Record<string, any>} mine @param {(tag: string, attrs: Record<string, any>) => Node | string} [make] */
function reminderWords(d, mine, make = h) {
  const words = d.plan ? planWords(d.plan) : String(d.text ?? '');
  const marked = d.plan ? {} : String(d.watch ?? '').startsWith('plan:') ? { lang: 'en' } : mine(words);
  return make('span', { ...marked, text: words });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A reminder's first sentence, about 80 characters at most, with no full stop: a watch's name in a line. @param {string} text */
const brief = (text) => {
  const first = (/^.+?(?:[.!?](?=\s|$)|[。！？])/su.exec(text.trim())?.[0] ?? text.trim()).replace(/[.!?。！？]+$/u, '');
  const chars = Array.from(graphemes.segment(first), (g) => g.segment); // whole characters: an emoji (a flag, a family) is never cut apart
  return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : first;
};

/**
 * An error's line in the Conversation, made from its data in the screens' language; null for one stored before it had any, which
 * is shown as stored, in annai's English. @param {any} d the event's data
 */
export function errorWords(d) {
  if (d.kind === 'model' && d.why) return whyWords(d.why);
  if (d.kind === 'compaction' && d.why) return tidyFailed(d.why);
  if (d.kind === 'budget' && (d.which === 'steps' ? typeof d.steps === 'number' : typeof d.perDay === 'number')) return budgetWords(d).body;
  if (d.kind === 'silent') return t`Her model finished without saying anything to you.`;
  if (d.kind === 'stuck') return t`Three identical tool calls in a row with identical results.`;
  // A watch is named briefly, as the user knows it, never by its id or its trigger's code: a plan watch by its item's title, another
  // by its reminder's first words. An older plan watch's entry kept its English fallback, no name for these words: shown as stored.
  const name = d.kind !== 'trigger' ? '' : typeof d.title === 'string' ? d.title : typeof d.reminder === 'string' && !String(d.watch).startsWith('plan:') ? brief(d.reminder) : '';
  if (name) return t`The watch for "${name}" can't be checked: ${String(d.why ?? '').replace(/[.!?。！？]$/u, '')}.`;
  return null;
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
 * Shows a conversation's events in order, missing none: it listens before it reads, so an event that comes
 * while the log is read is shown once, after them. Once the screen has left the page, it stops listening.
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
 * @param {any} ctx @param {{ parts: string[] }} [route] "#/trip/<id>/talk", or "#/talk" while no trip is open
 */
export async function renderTalk(ctx, route) {
  const agent = ctx.agent;
  // At a trip's own address (#/trip/<id>/talk), moving there opens that trip.
  if (route?.parts[0] === 'trip') openTrip(ctx);
  await agent.opening.catch(() => {}); // after a start or a trip change, the conversation is still being read
  // What Shiori's halves tell each other shows, and her spoken lines show their words, unless Settings say not (spec §16.1).
  const app = await readAppSettings(ctx.ws);
  const { showWords, showHalves: halves } = shownSettings(app);
  // The lines' languages (`lang`): the font and the screen reader's voice follow them. The user's by their text; Shiori's by the language she is set to answer in, else by her text.
  const mine = wording(app);
  const hers = wording(app, true);
  const scope = agent.scope;
  const rec = agent.trip ? await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ tx) => tx.getScope(agent.trip)) : null;
  const title = agent.trip ? (rec ? scopeTitle(rec) : t`Trip`) : '';
  // Not a live region: `announce` says each line of hers once, spoken or not, whatever "Show what she says" is, and words heard once
  // they are in; never what you typed, nor the halves' notes.
  const list = h('ol', { class: 'convo' });
  const announce = h('div', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const tell = (/** @type {string[]} */ [before, said, after], /** @type {string | undefined} */ lang) => { if (built && (before || said)) announce.replaceChildren(h('span', {}, before, h('span', { lang }, said), after)); };
  /** Heard lines announced, and those waiting HEARD_MS for more words: each is announced once, as its last revision. @type {Map<string, any>} */
  const hearing = new Map();
  /** @param {string} id @param {HeardLine} line */
  const hearSoon = (id, line) => {
    if (!built || hearing.get(id) === true) return;
    clearTimeout(hearing.get(id));
    hearing.set(id, setTimeout(() => {
      hearing.set(id, true);
      const kind = lineKind({ type: 'heard', data: line.data })?.kind;
      const words = line.words.textContent ?? '';
      tell(/** @type {string[]} */ (around(kind === 'unanswered' ? t`Heard, she didn't answer: ${WORDS}` : kind === 'judged' ? t`Heard, not for Shiori: ${WORDS}` : t`Heard: ${WORDS}`, words)), mine(words).lang);
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
  /** @typedef {{ data: any, words: HTMLElement, li: HTMLElement }} HeardLine */
  /** @type {Map<string, HeardLine>} heard lines, by id: their words are written down, or end, later (heard.text) */
  const unheard = new Map();
  /** Heard lines the user said were for her ("This was for Shiori"): the quiet line has no button any more. @type {Set<string>} */
  const claimed = new Set();
  /** What each ask offered, by call id: a one-half answer doesn't say it was tapped. @type {Map<string, string[]>} */
  const offered = new Map();
  /** A heard line, as it stands now: what it is follows its words, and a quiet line offers "This was for Shiori" until it is used. @param {HeardLine} l */
  const drawHeard = (l) => {
    const line = /** @type {import('../line-kind.js').Line} */ (lineKind({ type: 'heard', data: l.data }));
    const quiet = line.kind === 'unanswered' || line.kind === 'judged';
    l.li.className = lineClass(line, quiet ? 'you quiet' : 'you heard');
    // Only real words can be claimed: not before they come, and not the placeholder a sound that was never written down leaves.
    const words = typeof l.data.text === 'string' && l.data.text !== NOT_TRANSCRIBED;
    const claim = quiet && words && !claimed.has(l.data.id) ? h('button', {
      class: 'claim', type: 'button',
      onclick: () => {
        claimed.add(l.data.id);
        drawHeard(l);
        agent.send(l.words.textContent ?? '', { claim: l.data.id });
      },
    }, t`This was for Shiori`) : null;
    l.li.replaceChildren(h('p', {}, l.words), ...[lineLabel(line), claim].filter((x) => x !== null));
  };
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
  /** A note of the halves', quietly naming the model that wrote it (her own lines say it in their label). @param {any} d @param {HTMLElement} li */
  const by = (d, li) => {
    const who = modelWords(d.by);
    if (who) li.append(h('span', { class: 'sub by', text: who }));
    return li;
  };
  /** The files a message handed over, as chips under its words: each a link to where it is now, plain once it has moved on. @param {any} d */
  const handedChips = async (d) => {
    if (!Array.isArray(d.handed) || !d.handed.length) return null;
    const chips = [];
    // Shiori's short names where each file is now, read once a draw (goal 10); a file moved on keeps its own name.
    /** @type {Map<string, Record<string, string>>} */
    const names = new Map();
    for (const f of d.handed) {
      const m = /^\/(trip|waiting)(\/.+)$/.exec(String(f?.path ?? ''));
      const where = !m ? null : m[1] === 'waiting' ? SYS_WAITING : agent.trip;
      const there = where ? await ctx.store.tx(['files'], 'readonly', (/** @type {any} */ tx) => tx.getFile(where, m?.[2])) : null;
      const own = String(f?.name || f?.path || '');
      if (there && where && !names.has(where)) names.set(where, await readNames(ctx.ws, where));
      // Hers, else the name it was handed under (a photo kept as .webp still says .png).
      const theirs = there && where && m ? names.get(where) ?? {} : {};
      const shown = m && Object.hasOwn(theirs, m[2]) ? theirs[m[2]] : own;
      const name = h('span', { class: 'attach-name', dir: 'auto', text: shown });
      const title = shown !== own ? own : undefined;
      chips.push(there && m ? h('a', { class: 'attach-chip', title, href: where === SYS_WAITING ? waitingHref(m[2]) : recordHref(/** @type {string} */ (where), m[2], talkOf(ctx)) }, name) : h('span', { class: 'attach-chip gone' }, name));
    }
    return h('div', { class: 'chips handed' }, ...chips);
  };
  const undo = undoLine(ctx, scope, list);
  const dates = agent.trip ? datesLine(ctx, agent.trip, list) : null;
  /** @param {any} e */
  const item = async (e) => {
    const d = e.data ?? {};
    const line = await itemOf(e, d);
    return line && e.type === 'note' ? by(d, line) : line;
  };
  /** @param {any} e @param {any} d */
  const itemOf = async (e, d) => {
    const texts = { ...d, ...(await storedTexts(ctx.store, e)) };
    if (e.type === 'msg.user') {
      // Photos sent alone: the log's placeholder is the model's, the bubble's in the screens' words. Files handed over alone: no words.
      const said = d.images?.length && texts.text === PHOTO_ONLY ? t`(a photo)` : String(texts.text ?? '');
      const words = (Array.isArray(d.handed) || typeof d.handover === 'string') && said === FILES_ONLY ? null : h('p', { ...(said === texts.text ? mine(said) : {}), text: said });
      if (typeof d.claim === 'string') {
        claimed.add(d.claim);
        const was = unheard.get(d.claim);
        if (was) drawHeard(was);
      }
      const tapped = d.chose || offered.get(d.answer)?.includes(said); // one half's tapped answer stores no chose
      const line = /** @type {import('../line-kind.js').Line} */ (lineKind({ type: e.type, data: { ...texts, chose: tapped } }));
      // A copy of a line said in another conversation (a move, a hand-over): where it came from, with a way there, in place of how it was said.
      const src = typeof d.from === 'string' && d.from !== scope && kindOf(d.from) === 'trip' ? await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ tx) => tx.getScope(d.from)) : null;
      const from = src?.kind === 'trip' ? h('a', { class: 'line-label', href: talkHref(src.id) }, h('span', { text: tc('a conversation')`From ${scopeTitle(src)}` })) : null;
      return h('li', { class: lineClass(line, 'you') }, words, ...(await sentPhotos(e)), await handedChips(d), from ?? lineLabel(line));
    }
    if (e.type === 'out.speak') {
      const said = String(texts.text ?? '');
      const line = /** @type {import('../line-kind.js').Line} */ (lineKind({ type: e.type, data: d }));
      if (!d.voice) return h('li', { class: lineClass(line, 'shiori') }, h('span', { class: 'who', text: t`Shiori` }), h('p', { ...hers(said), text: said }), lineLabel(line));
      // Said aloud: its words show like any of hers, marked by the label; with "Show what she says" off, they fold away until asked (spec §2 principle 4, §16.1).
      if (showWords) return h('li', { class: lineClass(line, 'shiori said') }, h('span', { class: 'who', text: t`Shiori` }), h('p', { ...hers(said), text: said }), lineLabel(line));
      const words = h('p', { ...hers(said), text: said, hidden: true });
      const show = h('button', {
        class: 'btn ghost', type: 'button', 'aria-expanded': 'false',
        onclick: () => {
          words.hidden = !words.hidden;
          show.setAttribute('aria-expanded', String(!words.hidden));
          show.textContent = words.hidden ? t`Show what she said` : t`Hide`;
        },
      }, t`Show what she said`);
      return h('li', { class: lineClass(line, 'shiori said') }, h('span', { class: 'who', text: t`Shiori` }), show, words, lineLabel(line));
    }
    if (e.type === 'heard') {
      // What annai heard you say, so you can see what it understood (spec §10.3).
      const l = { data: d, words: h('span', {}), li: h('li', {}) };
      heardAs(l.words, typeof d.text === 'string' ? d.text : '…');
      unheard.set(d.id, l); // its words may come later, or end later (Gemini's input transcript): heard.text
      drawHeard(l);
      return l.li;
    }
    if (e.type === 'heard.text') {
      const l = unheard.get(d.of);
      if (l) {
        l.data = { ...l.data, text: String(d.text ?? '') };
        heardAs(l.words, l.data.text);
        drawHeard(l);
        hearSoon(d.of, l);
      }
      return null;
    }
    if (e.type === 'out.show') {
      const card = shownCard(d, { ctx, onChoice: (o) => agent.send(o, { chose: true }), say: hers });
      const undo = d.tune ? tuneUndo(ctx, d.tune) : null;
      const line = /** @type {import('../line-kind.js').Line} */ (lineKind({ type: e.type, data: d }));
      return h('li', { class: lineClass(line, 'shiori') }, h('span', { class: 'who', text: cardWho(ctx, d.card ?? {}) }), card, undo, lineLabel(line));
    }
    if (e.type === 'grounded') return groundedCard(d, texts, mine); // Google's words: by their script alone, not the language she answers in
    if (e.type === 'out.ask') {
      // annai's own card ends at the first tap: a second, before its result arrives, would be sent as a line of theirs.
      const buttons = (Array.isArray(d.options) ? d.options : []).slice(0, 6).map((/** @type {string} */ o) => h('button', { ...hers(String(o)), class: 'btn', type: 'button', onclick: () => {
        if (d.own) for (const b of buttons) b.disabled = true;
        agent.answer(d.tap ?? d.id, o);
      } }, String(o)));
      const line = /** @type {import('../line-kind.js').Line} */ (lineKind({ type: e.type, data: d }));
      // annai's own (Agent.confirm): the label says who asks.
      const node = h('li', { class: lineClass(line, 'shiori') }, h('span', { class: 'who', text: d.own ? /* en */ 'annai' : t`Shiori` }), h('p', { ...hers(String(d.question ?? '')), text: String(d.question ?? '') }), h('div', { class: 'acts' }, ...buttons), lineLabel(line));
      asks.set(d.id, node);
      offered.set(d.id, (Array.isArray(d.options) ? d.options : []).map(String));
      return node;
    }
    if (e.type === 'tool.result' && asks.has(d.id)) {
      for (const b of asks.get(d.id)?.querySelectorAll('button') ?? []) /** @type {HTMLButtonElement} */ (b).disabled = true;
      asks.delete(d.id);
      return null;
    }
    if (e.type === 'reminder') {
      const line = /** @type {import('../line-kind.js').Line} */ (lineKind({ type: e.type, data: d }));
      return h('li', { class: lineClass(line, 'note') }, h('p', {}, reminderWords(d, mine)), lineLabel(line));
    }
    // What the halves tell each other, set apart from her reminders; annai's own blocks to them stay in the Trace.
    if (e.type === 'note') return halves ? h('li', { class: 'halves-note' }, h('strong', { text: d.from === 'koe' ? t`Koe to Kokoro:` : t`Kokoro to Koe:` }), sentenceGap(), h('span', { ...hers(String(texts.text ?? '')), text: String(texts.text ?? '') })) : null;
    if (e.type === 'wake') {
      // What Shiori said of a trip before, written into the trip she started or opened for a hand-over: her line, in her words.
      const recap = (d.reasons ?? []).find((/** @type {any} */ r) => typeof r?.recap === 'string' && r.recap);
      if (recap) return h('li', { class: 'shiori' }, h('span', { class: 'who', text: t`Shiori` }), h('p', { ...hers(recap.recap), text: recap.recap }));
      // Kokoro's wakes are its own: the conversation is Koe's. A watch's wake says a lot, for Shiori: the line is cut.
      if (d.half === 'kokoro') return null;
      const others = (d.reasons ?? []).filter((/** @type {any} */ r) => !NOT_WOKE.includes(r.kind));
      if (!others.length) return null;
      const said = wokeText(others, (id) => String(ctx.plugins?.active?.get(id)?.manifest?.name ?? id));
      return h('li', { class: 'system-line' }, ...linkIn(said, ...wokeTitles(others).map((w) => h('span', { ...hers(w), text: w }))));
    }
    // Where a hand-over's files went, from its data, linked to the trip while it is there.
    if (e.type === 'handover.moved') {
      const rec = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ tx) => tx.getScope(String(d.to)));
      const said = movedWords(d, rec?.kind === 'trip' ? rec.title : null);
      return h('li', { class: 'system-line' }, rec?.kind === 'trip' ? h('a', { href: `#/trip/${encodeURIComponent(rec.id)}`, text: said }) : said);
    }
    // Where Shiori took the user from here (open_trip), with a way to that trip's conversation while it is there.
    if (e.type === 'conversation.moved') {
      const rec = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ tx) => tx.getScope(String(d.to)));
      const said = wentWords(rec?.kind === 'trip' ? scopeTitle(rec) : null);
      return h('li', { class: 'system-line' }, rec?.kind === 'trip' ? h('a', { href: talkHref(rec.id), text: said }) : said);
    }
    if (e.type === 'handover.undo') {
      if (d.handover === undo.handover) undo.done();
      return null;
    }
    // Shiori read another trip (read_trip): a quiet line, by the name it had then.
    if (e.type === 'trip.read') return h('li', { class: 'system-line', text: t`Shiori read ${scopeTitle({ id: String(d.trip), title: String(d.title ?? '') })}` });
    // Made from its type: the words stored with it are the card's English.
    if (e.type === 'paused') return h('li', { class: 'system-line', text: t`Shiori was in the middle of something. She picks it up when you come back.` });
    // "Start fresh" leaves a divider: everything above stays to read, search and recall; she no longer carries it in mind.
    if (e.type === 'compaction' && d.mode === 'fresh') return h('li', { class: 'fresh-divider', text: t`Started fresh` }); // a list item with its words: a separator has no name
    if (e.type === 'compaction') return h('li', { class: 'system-line', text: t`Earlier conversation summarized. The full log is in Trace.` });
    // The other half told the user, in its own words, or Kokoro's while Koe talks (a card still says it). A turn or a tidy-up every
    // model failed shows all the same, Kokoro's too; not Koe's, which Kokoro took over.
    const failed = (d.kind === 'model' || d.kind === 'compaction') && !(d.quiet && d.half === 'koe');
    if (e.type === 'error' && (d.quiet || d.aside) && !failed) return null;
    if (e.type === 'error') {
      // Out of sight of the card at the page's top: the note itself offers Try again, until something newer is in the conversation.
      const again = (d.kind === 'model' || d.kind === 'silent') && !d.quiet && !d.aside ? h('button', { class: 'btn', type: 'button', onclick: (/** @type {Event} */ ev) => { /** @type {HTMLButtonElement} */ (ev.currentTarget).remove(); agent.tryAgain(); } }, t`Try again`) : null;
      // Made from its data; an older entry's message is as stored, in annai's English.
      const words = errorWords(d);
      const li = h('li', { class: 'system' }, h('strong', { text: d.kind === 'model' ? t`Shiori can't reach her model` : d.kind === 'compaction' ? t`Shiori couldn't tidy up the conversation` : d.kind === 'budget' ? t`A budget ended her turn` : t`Her turn ended` }),
        h('p', words === null ? { lang: 'en', text: String(d.message ?? '') } : { text: words }), again);
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
  // photo loads or a frame takes its height too, until the user scrolls of their own accord.
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
    read: async () => {
      const got = (await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ tx) => tx.listEvents(scope, { types: SHOWN, reverse: true, limit: 400 }))).reverse();
      if (got.length >= 400) dates?.from(got[0].seq);
      return got;
    },
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
        undo.saw(e);
        dates?.saw(e, node);
        if (e.type === 'heard') {
          const l = unheard.get(e.data?.id);
          if (l && typeof e.data?.text === 'string') hearSoon(e.data.id, l);
        } else {
          // A plugin's kind of card is drawn by its plugin: the choices and the photo annai draws on its own cards are not on it.
          const kind = e.type === 'out.show' ? cardKind(ctx, e.data?.card) : '';
          const choices = (e.type === 'out.ask' ? e.data?.options : kind ? [] : e.data?.card?.choice);
          const pick = Array.isArray(choices) ? choices.slice(0, 6).map(String) : [];
          let words = plain(node);
          // A reminder reads as it says itself, not its words run into its label.
          if (e.type === 'reminder') words = reminderParts(e.data ?? {}, mine, (_, a) => String(a.text)).join('');
          else if (e.type === 'out.speak') words = node.querySelector('p')?.textContent ?? '';
          else if (e.type === 'out.ask') words = String(e.data?.question ?? '');
          else if (e.type === 'out.show') {
            // The card's own words, its blocks apart, without the label and the buttons that answer it (they are read as its choices).
            words = textOf(node, pick.length ? /* en */ '.who, .line-label, .card .acts button' : '.who, .line-label');
          }
          // Her words carry their language; annai's labels, errors and notes around and beside them do not.
          const parts = announced(e.type, kind, words, pick, e.type === 'out.ask' ? { own: Boolean(e.data?.own) } : kind ? {} : e.data?.card ?? {});
          if (e.type === 'grounded') {
            const [title, text] = [node.querySelector('strong')?.textContent ?? '', node.querySelector('p')?.textContent ?? ''];
            const rest = words.replace(title, '').replace(text, '').trim();
            tell([`${t`From ${sourceOf(e.data)}.`}${sentenceGap()}`, text, rest ? `${sentenceGap()}${rest}` : ''], mine(text).lang);
          } else tell(parts, ['out.speak', 'out.show', 'out.ask'].includes(e.type) ? hers(words).lang : undefined);
        }
        if (follow) toEnd();
        // A plugin's dock may have no avatar of annai's.
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
  const trip = agent.trip;
  const tidy = tidyMenu(ctx, trip ? { id: trip, dated: Boolean(rec?.start) } : null);
  const name = h('a', { class: 'talk-name', href: `#/trip/${encodeURIComponent(trip)}`, dir: 'auto', text: title });
  // The name follows trip.json while it shows: the first line names a new conversation, and Shiori may rename it or give it dates (a chat, then a trip).
  const offName = trip ? ctx.ws.onChange((/** @type {{ scope: string, path: string }} */ c) => {
    if (c.scope === trip && c.path === '/trip.json') ctx.ws.readJSON(trip, '/trip.json').then((/** @type {any} */ j) => {
      name.textContent = scopeTitle({ id: trip, title: String(j?.title ?? title) });
      tidy.dated(Boolean(tripMirror(j).start));
    }, () => {});
  }) : null;
  const screen = h('div', { class: 'screen' },
    // A trip's: ← home (never opening anything), its name to Details, and the conversation's ⋯ (Details too, Tidy up), staying under the app's bar on a
    // long conversation. The heading stays for the top bar's tests until it goes (stage 8).
    ...(trip ? [
      h('div', { class: 'talk-head' },
        h('a', { class: 'btn ghost talk-back', href: '#/trips', 'aria-label': t`Back to Trips`, text: '←' }),
        name,
        tidy.el, tidy.status),
      h('h1', { class: 'visually-hidden', text: t`Conversation` }),
      await nextLine(ctx, trip),
    ] : [
      // The menu is a ⋯ by the title, out of the conversation's way, and stays under the app's bar on a long conversation.
      h('div', { class: 'title-row' }, h('h1', { class: 'title', text: t`Conversation` }), tidy.el, tidy.status),
      h('p', { class: 'sub', text: t`No trip is open. Open one from Trips, or talk here: Shiori can still use /me/.` }),
    ]),
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
    dates?.off();
    offName?.();
    tidy.off();
    for (const timer of hearing.values()) clearTimeout(timer);
    removeEventListener('message', fit);
    for (const type of USER) removeEventListener(type, own);
    grows.disconnect();
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  });
  return screen;
}

/**
 * The conversation's Next line, "Next: 13:00 Lunch" (a day first when it isn't today), opening the trip's Itinerary; null when nothing more
 * is planned. When its row is over it draws the next one, by its own timer: live mode may never change with GPS off.
 * @param {any} ctx @param {string} id the trip @returns {Promise<HTMLElement | null>}
 */
export async function nextLine(ctx, id) {
  const line = h('p', { class: 'next-line' });
  const fill = async () => {
    const { rows } = await tripRows(ctx, id);
    const now = nowOf(ctx.live);
    const [r] = upcoming(rows, now, 1);
    // Once drawn, the line keeps its place when nothing more is planned, so the conversation under it doesn't move.
    line.style.visibility = r ? '' : 'hidden';
    if (!r) return false;
    const name = rowName(r);
    line.replaceChildren(h('a', { href: `#/trip/${encodeURIComponent(id)}/plan`, dir: 'auto' },
      r.day && r.day !== todayOf(ctx.live) ? t`Next: ${day(r.day, true)} ${r.time} ${name}` : t`Next: ${r.time} ${name}`));
    // A timer holds at most about 24 days; a longer wait draws the same row again then, and waits on.
    // Gone from the page, it stops.
    setTimeout(() => { if (line.isConnected) fill().catch(() => {}); }, Math.min(Math.max(over(r) - now, 0) + 1000, 2 ** 31 - 1));
    return true;
  };
  return (await fill()) ? line : null;
}

/**
 * "Shiori set the dates": a line in the conversation at each write of hers that gave a chat its dates (it became a trip), under her lines after it
 * until the user's next line, as the hand-over's Undo line is. Each is a record of what happened, so it stays at its place whatever comes after,
 * through a reload (the user, 2026-11-10, "Stay, without Undo"). Only the one whose dates still stand has Undo, which takes back only those
 * (herDatings, undoDating), as the user's write, so the row goes back to a line and keeps a name given since. Once undone it says so in its place,
 * as the hand-over's line does; once the dates were changed otherwise (by her, or the user in Details), it is the line alone. Drawn again whenever
 * trip.json changes. @param {any} ctx @param {string} scope @param {HTMLElement} list the conversation's lines
 */
function datesLine(ctx, scope, list) {
  /** Each line shown: its entry's seq, and whether it is the user's own or hers. @type {WeakMap<Element, { seq: number, talks: boolean, hers: boolean }>} */
  const shown = new WeakMap();
  /** @typedef {Awaited<ReturnType<typeof herDatings>>[number]} Dating */
  /** Each dating's line, by its seq, and what it shows. @type {Map<number, { li: HTMLElement, state: Dating['state'] }>} */
  const lines = new Map();
  /** The dating each of those lines is at. @type {WeakMap<Element, number>} */
  const at = new WeakMap();
  /** Her datings, oldest first. @type {Dating[]} */
  let datings = [];
  /** The oldest line read, when the conversation has more than are read: a dating before it has no place among them. */
  let from = 0;
  const place = () => {
    for (const { seq } of datings) {
      const li = /** @type {{ li: HTMLElement }} */ (lines.get(seq)).li;
      if (seq < from) {
        li.remove();
        continue;
      }
      /** @type {Element | null} */
      let after = null;
      for (const node of list.children) {
        const was = at.get(node);
        if (was !== undefined) {
          if (was < seq) after = node; // an earlier dating's line comes before it
          continue;
        }
        const d = shown.get(node);
        if (!d) continue;
        if (d.seq > seq && d.talks) break; // the user's next line: it stays above it
        if (d.seq < seq || d.hers) after = node;
      }
      if (after ? after.nextElementSibling !== li : list.firstElementChild !== li) {
        if (after) after.after(li);
        else list.prepend(li);
      }
    }
  };
  /** Its Undo, while its dates stand. @param {Dating} dating */
  const undoOf = (dating) => {
    const undo = h('button', {
      class: 'btn ghost', type: 'button', 'aria-label': t`Undo the dates Shiori set`,
      onclick: async () => {
        undo.disabled = true;
        // Said, as the hand-over's Undo is, and the line says Undone. A line drawn before a later change only loses its Undo.
        await undoDating(ctx.ws, scope, dating).then((undone) => (undone ? ctx.notices.toast(t`Undone.`) : draw()), (/** @type {unknown} */ x) => {
          undo.disabled = false;
          ctx.notices.toast(messageOf(x));
        });
      },
    }, t`Undo`);
    return undo;
  };
  /** A dating's line as it is now; one that already shows it is left as it is (its Undo keeps focus). @param {Dating} dating */
  const fill = (dating) => {
    const had = lines.get(dating.seq);
    if (had?.state === dating.state) return;
    const li = had?.li ?? h('li', { class: 'system-line dates-line' });
    at.set(li, dating.seq);
    lines.set(dating.seq, { li, state: dating.state });
    const said = h('span', { text: t`Shiori set the dates` });
    if (dating.state === 'stands') li.replaceChildren(said, ' ', undoOf(dating));
    else if (dating.state === 'undone') li.replaceChildren(said, ' ', h('span', { class: 'sub', role: 'status', text: t`Undone` }));
    else li.replaceChildren(said);
  };
  let drawn = 0;
  const draw = async () => {
    const mine = ++drawn;
    const now = await herDatings(ctx.store, scope).catch(() => null);
    if (mine !== drawn || !now) return; // a read that failed changes nothing shown
    for (const d of now) fill(d);
    datings = now;
    place();
  };
  draw();
  const off = ctx.ws.onChange((/** @type {{ scope: string, path: string }} */ c) => { if (c.scope === scope && c.path === '/trip.json') draw(); });
  return {
    /** A line just shown, where it is in the log. @param {any} e @param {Element} node */
    saw(e, node) {
      shown.set(node, { seq: e.seq, talks: talks(e), hers: ['out.speak', 'out.show', 'out.ask'].includes(e.type) });
      place();
    },
    /** @param {number} seq the oldest line read, of more */
    from(seq) {
      from = seq;
      place();
    },
    off,
  };
}

/**
 * The Undo line of the newest hand-over in a conversation: under her last line after it, moving down as she adds lines until the user writes or speaks again; there only
 * while there is something to take back. A trip she started for the files, with nothing of the user's in it, goes, its files back with Shiori.
 * @param {any} ctx @param {string} scope the conversation's @param {HTMLElement} list its lines
 */
function undoLine(ctx, scope, list) {
  /** @type {string | null} */
  let handover = null;
  let placing = false;
  let used = false;
  /** The trips each hand-over's files went to (handover.moved). @type {Map<string, Set<string>>} */
  const went = new Map();
  const line = h('li', { class: 'system-line undo-line', hidden: true });
  const done = () => {
    used = true;
    line.hidden = false;
    line.replaceChildren(h('span', { class: 'sub', role: 'status', text: t`Undone` }));
  };
  const run = async () => {
    const hh = /** @type {string} */ (handover);
    const here = location.hash; // a screen the user goes to while it runs stands
    button.disabled = true;
    try {
      await settled(ctx.agent);
      // The trips its files went to, this conversation, and the one it was handed in: each told, through its own log while it is open.
      /** @type {Set<string>} the trips it removes: a screen of one is left for the files' conversation, else as Remove does */
      const gone = new Set();
      const outcome = await undoEverywhere(ctx.ws, scope, hh, {
        remove: (s) => { gone.add(s); return removeTripNow(ctx, s); },
        log: (s) => (s === ctx.agent.scope ? (/** @type {any} */ ev) => ctx.agent.log(ev) : undefined),
      });
      const { removed, waiting, back } = outcome;
      done();
      // Said where the files went, whether or not a trip went, and shown there: a trip they went back to opens, Waiting is on Trips.
      ctx.notices.toast(undoneWords(outcome));
      const on = () => { const at = parseHash(location.hash); return at.parts[0] === 'trip' && gone.has(at.parts[1] ?? '') ? at.parts[1] : null; };
      if (!waiting && back.length) {
        await updateAppSettings(ctx.ws, { activeTrip: back[0].id });
        await openOrTell(ctx, back[0].id);
        if (location.hash !== here && !on() && location.hash !== talkOf(ctx)) return;
        if (location.hash === talkOf(ctx)) await ctx.render();
        else toTalk(ctx);
      } else if (location.hash !== here && !on()) return;
      else if (waiting || removed.length) {
        const id = on();
        if (id) ctx.removed(id);
        else ctx.go('#/trips');
      }
    } catch (e) {
      button.disabled = false;
      ctx.notices.toast(messageOf(e));
    }
  };
  const button = h('button', { class: 'btn ghost', type: 'button', 'aria-label': t`Undo what Shiori did with these files`, onclick: run }, t`Undo`);
  /** Shows it only while there is something to take back. */
  const check = async () => {
    const hh = handover;
    if (!hh || used) return;
    const any = (await Promise.all([scope, ...(went.get(hh) ?? [])].map((s) => undoable(ctx.store, s, hh)))).some(Boolean);
    if (hh === handover && !used) line.hidden = !any;
  };
  return {
    get handover() { return handover; },
    done,
    /** A line just shown: a hand-over starts its Undo; the user's own words stop it moving; her lines after it take it down with them. @param {any} e */
    saw(e) {
      const d = e.data ?? {};
      if (e.type === 'msg.user' && typeof d.handover === 'string') {
        handover = d.handover;
        placing = true;
        used = false;
        line.hidden = true;
        line.replaceChildren(button);
        button.disabled = false;
        line.remove();
        return;
      }
      if (e.type === 'msg.user' || (e.type === 'heard' && !d.dismissed)) placing = false;
      if (e.type === 'handover.moved' && typeof d.handover === 'string') went.set(d.handover, new Set([...(went.get(d.handover) ?? []), String(d.to)]));
      if (!placing || !handover || used || !['out.speak', 'out.show', 'out.ask', 'handover.moved', 'conversation.moved'].includes(e.type)) return;
      list.append(line);
      check();
    },
  };
}

/**
 * The Conversation screen's menu, a ⋯: Details (a trip's or a chat's own page, where its name goes too: its name and dates, Export, Archive and
 * Remove), Summarize now, which runs housekeeping as it would run by itself, and Start fresh, which has Shiori start a new context from here.
 * Neither of those deletes a line (spec §6.5, §16.2). A conversation with no trip open has no Details.
 * @param {any} ctx @param {{ id: string, dated: boolean } | null} trip the conversation's trip, and whether it has dates (a trip; else a chat)
 * @returns {{ el: HTMLElement, status: HTMLElement, dated: (on: boolean) => void, off: () => void }} the ⋯ and its menu, a line that says "Starting fresh…" while Start
 *   fresh runs, what says whether the conversation has dates now, for the words under Details, and what takes the menu's listeners off window and document
 *   (the screen calls it when it is gone)
 */
function tidyMenu(ctx, trip) {
  const agent = ctx.agent;
  const toggle = h('button', { class: 'btn ghost tidy-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'tidy-menu', 'aria-label': t`Conversation menu` }, '⋯');
  const menu = h('div', { id: 'tidy-menu', class: 'tidy-menu', role: 'group', 'aria-label': t`Conversation menu`, hidden: true });
  const close = () => {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  /** The max-height it was given last, so a frame that finds the same room writes nothing. */
  let height = -1;
  /** Until when (performance.now()) the menu ignores clicks: a lift that opened it took the ⋯ from under the finger, and what moved ignores taps a moment (notices.js). */
  let moved = 0;
  // A click, not pointer-events: none, which would let the tap fall through to the conversation under the menu.
  menu.addEventListener('click', (e) => { if (performance.now() < moved) { e.preventDefault(); e.stopPropagation(); } }, true);
  /** A finger is on the menu: it keeps its height until the finger is up. Taller, a menu scrolled to its end would shift under it, and a tap would land on another entry. */
  let finger = false;
  // `touches` is every finger on the screen: one resting on the page, or a pinch's other half, is no finger on the menu.
  for (const type of ['touchstart', 'touchend', 'touchcancel']) menu.addEventListener(type, (e) => { finger = Array.from(/** @type {TouchEvent} */ (e).touches).some((t) => menu.contains(/** @type {Node} */ (t.target))); }, { passive: true });
  /** The room under the ⋯ for the menu: down to 16 px above the dock (which is over the page's bottom, as tall as it is now); less than none where the ⋯ is under it. */
  const room = () => {
    const dock = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) || 0;
    return innerHeight - dock - toggle.getBoundingClientRect().bottom - 16;
  };
  /**
   * The menu's height: that room, so what it holds beyond it scrolls inside it. 16 px is the gutter the page keeps at the screen's sides (.view, base.css), so
   * the menu ends as far above the dock as the page does from the edge. The title sits as low as the cards and banner above it leave it, which on a short
   * conversation the page can't scroll away under the bar, so no fixed height clears the dock: it is measured where the ⋯ is.
   */
  const fit = () => {
    if (finger) return;
    const px = Math.max(0, room());
    if (px !== height) menu.style.maxHeight = `${height = px}px`;
  };
  /**
   * While it is open the room is measured every frame: that holds whatever moves the ⋯ or the dock with no scroll or resize (a card landing above a short
   * conversation at the top of its page, the dock growing or shrinking, a phone turned back upright: the shell's observers update --dock-h and --topbar-h a
   * frame after the resize event). A frame costs about 0.001 ms with a clean layout, 0.04 ms at worst (360x640, Chromium and WebKit, a loaded host).
   */
  let frame = 0;
  const watch = () => {
    frame = 0;
    if (menu.hidden) return;
    fit();
    frame = requestAnimationFrame(watch);
  };
  toggle.addEventListener('click', () => {
    if (toggle.getAttribute('aria-disabled') === 'true') return;
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
    // A scroll box keeps its scroll while hidden (both engines): it opens at its top each time, where Details is.
    menu.scrollTop = 0;
    if (menu.hidden) return;
    finger = false; // a touch that ended while it was closed, or never did, holds nothing
    // Details, its first entry, is in view and can be tapped as it opens: where the ⋯ is too low for that (a card and the install banner above a short
    // conversation, a phone on its side), the page lifts the ⋯ by what is missing, once, before the menu is drawn. Nothing moves the page after. A page at
    // its end can't lift it: nothing moved, and the menu takes taps at once.
    const first = /** @type {HTMLElement} */ (menu.querySelector('a.btn, button.btn'));
    const { paddingBottom, borderBottomWidth } = getComputedStyle(menu);
    const need = first.getBoundingClientRect().bottom - menu.getBoundingClientRect().top + parseFloat(paddingBottom) + parseFloat(borderBottomWidth);
    const y = scrollY;
    if (need > room()) scrollBy(0, need - room());
    if (scrollY !== y) moved = performance.now() + MOVED_MS;
    fit();
    if (!frame) frame = requestAnimationFrame(watch);
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
  // The button is a ⋯, so sighted users read it here; the button's own name says it to a screen reader.
  const status = h('span', { class: 'sub tidy-status', 'aria-hidden': 'true', hidden: true, text: t`Starting fresh…` });
  /** Start fresh runs: the toggle says so, and opens nothing meanwhile. @param {boolean} on */
  const working = (on) => {
    toggle.setAttribute('aria-busy', String(on));
    toggle.setAttribute('aria-disabled', String(on));
    toggle.setAttribute('aria-label', on ? t`Starting fresh…` : t`Conversation menu`);
    status.hidden = !on;
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
        ctx.notices.toast(t`She couldn't start fresh: ${messageOf(e)}`);
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
  const aboutDetails = h('p', { id: 'tidy-details', class: 'sub', text: detailsWords(Boolean(trip?.dated)) });
  menu.append(
    ...(trip ? [aboutDetails, h('a', { class: 'btn', href: `#/trip/${encodeURIComponent(trip.id)}`, 'aria-describedby': 'tidy-details', text: t`Details` })] : []),
    h('p', { id: 'tidy-summarize', class: 'sub', text: t`Summarize now: Shiori sums up the earlier conversation now, to keep it short. Every line stays here, and she can still look them up.` }), summarize,
    h('p', { id: 'tidy-fresh', class: 'sub', text: t`Start fresh: Shiori puts the earlier lines out of mind and starts over from here. Every line stays here, above a divider.` }), fresh,
    h('a', { class: 'btn', href: '#/sees?half=kokoro', text: t`What each half sees` }));
  // The menu is in the head, inside the screen the shell replaces as a whole, so nothing here sees it go: the screen calls off when it goes.
  const off = () => {
    offTap();
    document.removeEventListener('keydown', escape);
    cancelAnimationFrame(frame);
  };
  return { el, status, dated: (on) => { aboutDetails.textContent = detailsWords(on); }, off };
}

/** What Details holds, in the words of what it is: a trip (it has dates) or a chat. @param {boolean} dated */
const detailsWords = (dated) => dated ? t`Details: the trip's name and dates, Export, Archive and Remove.` : t`Details: the chat's name and dates, Export, Archive and Remove.`;

/**
 * The Undo under a "I adjusted my personality" card. Once done it says so and offers no second Undo; a card for a change that is
 * already back as it was (undone before, or put back by hand) says so from the start.
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
        ctx.notices.toast(messageOf(e));
      }
    },
  }, t`Undo`);
  el.append(button);
  if (tune.old) ctx.ws.read(ME, /* en */ `/personalities/${tune.name}.md`).then((/** @type {any} */ now) => { if (now?.entry.hash === tune.old) done(); }, () => {});
  return el;
}
