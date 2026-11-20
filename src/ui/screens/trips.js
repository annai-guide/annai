import { h, t, plural, messageOf, whenGone, otherLang } from '../dom.js';
import { listTrips, backupState, scopeTitle, changesTrip, lastTalked, linesSaid, ME } from '../../core/scopes.js';
import { filesToRead } from '../../core/handover.js';
import { readAppSettings } from '../../core/settings.js';
import { ValidationError } from '../../core/workspace.js';
import { relTime, relChange, dateRange, backupText, wording, replyBefore, talkHref, day, when, rowName, madeByLine } from '../format.js';
import { openFileButton } from '../open-file.js';
import { tripStamps, stampMarks, factsWords } from '../stamps.js';
import { stampCount } from '../../core/after/stamps.js';
import { timelineRows, dayOfTrip, recentFrom } from '../../core/timeline.js';
import { upcoming, over } from '../../core/now.js';
import { dayIn, deviceZone, nextDay } from '../../core/time.js';
import { storedTexts } from '../../core/agent/log.js';
import { tripRows } from '../trip-rows.js';
import { nowOf } from '../today.js';
import { realClock } from '../../core/live/clock.js';
import { keepRows } from '../keep-rows.js';
import { slotEntries } from '../slots.js';

/** @typedef {import('../../core/timeline.js').Row} Row */
/** Words saying how long ago (since): the node, its moment on the device's clock, its words at a moment. @typedef {{ node: Node, at: number, words: (now: number) => string }} Since */
/** The cards' backups, by trip (backupState). @typedef {Map<string, { at: number | null, changed: boolean }>} Backups */

/**
 * Home: the timeline of trips and chats (the timeline design), old to new, the trips happening at the now line and only dated trips below it.
 * A tap opens a row's conversation. What a card shows beyond its dates is read for cards alone, so chats cost no reads. The foot holds the archived
 * trips, Open a file and the last backup; a trip starts with the shell's + (timeline stage 8 took the Start a trip form away). `me`'s old lines are a
 * row of their own.
 * @param {any} ctx
 */
export async function renderTrips(ctx) {
  // The trips followed from before the cards read their backups (tripCard), so an entry that lands while home is drawn is kept for followClock: a card
  // that read "backed up" just before it says "changed since" all the same.
  /** @type {{ touched: Set<string>, mark: () => void }} */
  const follow = { touched: new Set(), mark: () => {} };
  const stop = ctx.appended?.((/** @type {import('../../core/types.js').EventRecord[]} */ evs) => {
    for (const e of evs) if (changesTrip(e.type)) follow.touched.add(e.scope);
    follow.mark();
  });
  try {
    return await drawTrips(ctx, follow, stop);
  } catch (e) {
    stop?.();
    throw e;
  }
}

/** @param {any} ctx @param {{ touched: Set<string>, mark: () => void }} follow @param {(() => void) | undefined} stop */
async function drawTrips(ctx, follow, stop) {
  const { active, archived } = await listTrips(ctx.store);
  const settings = await readAppSettings(ctx.ws);
  const places = ctx.backups ? await ctx.backups.list() : [];
  const latest = places.filter((/** @type {any} */ p) => p.last).sort((/** @type {any} */ a, /** @type {any} */ b) => b.last.at - a.last.at)[0];
  /** due: when a card's Next stops being next, pushed by the happening cards as they are drawn. */
  const o = { say: wording(settings), hers: wording(settings, true), now: nowOf(ctx.live), zone: ctx.live?.timeZone?.() ?? deviceZone(), due: /** @type {number[]} */ ([]), since: /** @type {Since[]} */ ([]), backups: /** @type {Backups} */ (new Map()) };
  // `me`'s old lines are a row of their own, by the last line the user said there (the user, 2026-11-05, "Read-only row"); with none, there is nothing of theirs to read back.
  const meAt = await meTalked(ctx.store);
  const rows = meAt === null ? active : [...active, { id: ME, title: '', created: meAt, talked: meAt }];
  const { above, happening, below } = timelineRows(rows, o.now, o.zone);
  const byId = new Map(rows.map((s) => [s.id, s]));
  const row = (/** @type {Row} */ r) => (r.card ? tripCard(ctx, byId.get(r.id), r, o) : chatLine(byId.get(r.id), r, o));
  const past = await Promise.all(above.map(async (e) => {
    if (e.heading) return h('li', { class: 'when' }, h('h2', { class: 'section', text: e.heading.kind === 'day' ? day(e.heading.key, true) : monthName(e.heading.key) }));
    if (e.fold) {
      return h('li', { class: 'fold' }, fold(e.fold.month,
        h('summary', { text: plural(e.fold.rows.length, '{0}: # chat', '{0}: # chats', monthName(e.fold.month)) }),
        h('ul', { class: 'cards' }, ...e.fold.rows.map((r) => chatLine(byId.get(r.id), r, o)))));
    }
    return row(/** @type {Row} */ (e.row));
  }));
  const ahead = await Promise.all([...happening, ...below].map(row));
  const archivedCards = await Promise.all(archived.map((s) => tripCard(ctx, s, null, o)));
  const saved = latest ? { at: latest.last.at, words: (/** @type {number} */ now) => t`Last backup ${relTime(latest.last.at, now)}, to ${latest.name}.` }
    : settings.lastExportAt ? { at: settings.lastExportAt, words: (/** @type {number} */ now) => t`Last export ${relTime(settings.lastExportAt, now)}.` } : null;
  const screen = h('div', { class: 'screen timeline' },
    homeHead(ctx),
    // The shell scrolls the now line 40% down; with less past than that above it, it sits higher, with no blank space over it (a notice there stays in view).
    h('ul', { class: 'cards rows past' }, ...past),
    h('p', { class: 'now-line' }, h('span', { text: t`Now` })),
    h('ul', { class: 'cards rows ahead' }, ...ahead),
    active.length ? null : h('p', { class: 'empty', text: t`Tap + to talk to Shiori.` }),
    archived.length
      ? fold('archived', h('summary', { text: t`Archived (${archived.length})` }), h('ul', { class: 'cards' }, ...archivedCards))
      : null,
    openFileButton(ctx),
    saved ? since(o, h('p', { class: 'sub' }), saved.at, saved.words) : h('p', { class: 'sub', text: t`No backup yet. Export everything from Settings, or set up automatic backups there.` }));
  followClock(ctx, screen, o, places, follow, stop);
  return screen;
}

/**
 * Home's head: "Trips", then Trace and the gear (Settings) at its end (the user's pick 2026-11-16, "At the top, beside "Trips""); under it, only
 * when a plugin has one, a quiet row of links to plugins' screens with a tab (`tab: true`). Not sticky: home's box of cards sticks at the top.
 * @param {any} ctx
 */
function homeHead(ctx) {
  const tabs = slotEntries(ctx, 'ui:screen').filter((e) => e.item?.tab).map((e) => h('a', {
    href: `#/ext/${encodeURIComponent(e.pluginId)}/${encodeURIComponent(e.item.id)}`, lang: otherLang(ctx.plugins?.langOf(e.pluginId)), text: String(e.item.title),
  }));
  return h('div', { class: 'home-head' },
    h('div', { class: 'home-top' },
      h('h1', { class: 'title', text: t`Trips` }),
      h('a', { class: 'btn ghost', href: '#/trace' }, t`Trace`),
      h('a', { class: 'btn ghost gear', href: '#/settings', 'aria-label': t`Settings` }, '⚙')),
    tabs.length ? h('p', { class: 'home-links' }, ...tabs) : null);
}

/**
 * Words saying how long ago ("backed up 5 minutes ago"), on the device's clock: the node carries its moment and followClock changes its words as they
 * change, with no redraw. @param {{ since: Since[] }} o @param {HTMLElement} node @param {number} at @param {(now: number) => string} words
 */
function since(o, node, at, words) {
  node.textContent = words(Date.now());
  o.since.push({ node, at, words });
  return node;
}

/**
 * Home is drawn for an instant: its Next, "Day 3 of 8", which trips are happening and the "tomorrow" it says go stale as time passes. It draws itself again,
 * in place, at the earliest moment one of them changes (a Next item ends, or midnight; the 1 s is for a timer a hair early), on live mode's own timer, so a
 * simulation played faster is drawn at its own moments (and again when one starts or ends: live mode's clock is another then); and when annai comes back to
 * the front, which a phone's timers may have slept through and where the phone's zone may be another (a flight); and when a backup has run, which its
 * card and the footer tell. Only while it is the screen shown and its address. Its folds and the place stay (`fold`). How long ago a backup was changes
 * its words in place (since), the rows in view kept where they were, as does a trip changed while home shows (through the dock): "changed since".
 * @param {any} ctx @param {HTMLElement} screen @param {{ now: number, zone: string, due: number[], since: Since[], backups: Backups }} o @param {{ id: string }[]} places backups'
 * @param {{ touched: Set<string>, mark: () => void }} follow the trips with entries since home began drawing (renderTrips) @param {(() => void) | undefined} stop
 */
function followClock(ctx, screen, o, places, follow, stop) {
  const at = location.hash;
  const redraw = () => {
    if (!screen.isConnected || location.hash !== at) return; // gone, or going: a redraw now would send a tap's move back
    ctx.render();
  };
  const clock = ctx.live?.clock ?? realClock();
  const next = Math.min(nextDay(o.now, o.zone), ...o.due);
  const timer = clock.set(redraw, Math.max(next - o.now, 0) + 1000);
  // The device's clock, whatever live mode's is; it waits a change weeks ahead ("2 months ago") in steps: setTimeout holds 24.8 days at most.
  const real = realClock();
  /** @type {any} */
  let tick;
  const words = () => {
    real.clear(tick);
    const now = Date.now();
    const changed = o.since.filter((s) => s.node.textContent !== s.words(now));
    // Words that take another line move what is under them: the rows in view stay where they were, as at a redraw (shell.js).
    if (changed.length) keepRows(screen, () => { for (const s of changed) s.node.textContent = s.words(now); });
    const change = Math.min(...o.since.map((s) => relChange(s.at, now)));
    if (change < Infinity) tick = real.set(words, change - now + 1000); // a second past, as the redraw's
  };
  words();
  // A trip with an entry that changes what a Backup holds, since home began drawing or from now on: its card says "changed since", in place.
  follow.mark = () => {
    let changed = false;
    for (const id of follow.touched) {
      const b = o.backups.get(id);
      if (b && !b.changed) changed = b.changed = true;
    }
    follow.touched.clear();
    if (changed) words();
  };
  follow.mark();
  const front = () => { if (document.visibilityState === 'visible') redraw(); };
  document.addEventListener('visibilitychange', front);
  const swapped = ctx.sim?.onChange?.(() => { if ((ctx.live?.clock ?? clock) !== clock) redraw(); });
  // A backup that ended: no place is running one (its progress emits too).
  const backedUp = ctx.backups?.on?.(() => { if (!places.some((p) => ctx.backups.progress(p.id))) redraw(); });
  whenGone(screen, () => {
    clock.clear(timer);
    real.clear(tick);
    document.removeEventListener('visibilitychange', front);
    swapped?.();
    backedUp?.();
    stop?.();
  });
}

/** Home's folds that are open (a month's, 'archived'), kept so while annai runs: Back, or a redraw, finds home as it was. */
const unfolded = new Set();
/** @param {string} key @param {...HTMLElement} parts */
function fold(key, ...parts) {
  const el = h('details', { class: key === 'archived' ? key : undefined, open: unfolded.has(key) }, ...parts);
  el.addEventListener('toggle', () => (el.open ? unfolded.add(key) : unfolded.delete(key)));
  return el;
}

/** "October 2026", for a "YYYY-MM". @param {string} key */
const monthName = (key) => when(Date.parse(`${key}-01T00:00:00Z`), 'UTC', { month: 'long', year: 'numeric' });

/**
 * A chat: one line, its name and its time (under a month's heading, its day too); a tap opens its conversation. `me`'s is "Shiori, no trip", opening its
 * lines to read. @param {any} s @param {Row} r @param {{ say: ReturnType<typeof wording>, now: number, zone: string }} o
 */
function chatLine(s, r, { say, now, zone }) {
  const me = s.id === ME;
  const name = me ? t`Shiori, no trip` : scopeTitle(s);
  const monthly = /** @type {string} */ (dayIn(r.at, zone)) < recentFrom(now, zone); // as its heading: by the calendar day, not by 30 times 24 hours
  return h('li', {}, h('a', { class: 'card trip-card line', href: me ? '#/talk/me' : talkHref(s.id) },
    h('span', { class: 'name', ...(me ? {} : say(name)), text: name }),
    madeByLine(s),
    h('span', { class: 'sub', text: when(r.at, zone, { ...(monthly ? { month: 'short', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }) })));
}

/**
 * A trip's card (spec §16.2, the timeline design): its name and dates, its stamps (spec §13), files waiting to be read there, and when it was last
 * backed up (§4.9); happening, "Day 3 of 8" and its Next; ahead, how soon and her last line there; its own colour, lit by its lines (litOf). A tap
 * opens its conversation; an archived one's opens Details, where Unarchive is. @param {any} ctx @param {any} s its record @param {Row | null} r its row; null: archived
 * @param {{ say: ReturnType<typeof wording>, hers: ReturnType<typeof wording>, now: number, zone: string, due: number[], since: Since[], backups: Backups }} o
 * say: the name is the user's words, in their language, not the screens'; hers: her last line
 */
async function tripCard(ctx, s, r, o) {
  const { say, hers, now, zone, due } = o;
  const [backup, stamps, unread, said] = await Promise.all([backupState(ctx.store, s.id), tripStamps(ctx, s.id), r ? filesToRead(ctx.store, s.id).then((f) => f.length) : 0, r ? linesSaid(ctx.store, s.id, STEPS[STEPS.length - 1]) : 0]);
  o.backups.set(s.id, backup);
  // Its "backed up … ago" is on its own moment: the footer line's is another place's (or an export's), and a trip's backup can outlive its place.
  const backedUp = backup.at === null ? backupText(backup) : since(o, h('span', {}), backup.at, (now) => backupText(backup, now));
  /** @type {HTMLElement[]} */
  const more = [];
  if (r?.phase === 'happening') {
    const d = dayOfTrip(s, now, zone);
    if (d) more.push(h('span', { class: 'sub day-of', text: t`Day ${d.day} of ${d.of}` }));
    const [next] = upcoming((await tripRows(ctx, s.id).catch(() => ({ rows: [] }))).rows, now, 1);
    if (next) due.push(over(next));
    if (next) more.push(h('span', { class: 'sub next', dir: 'auto', text: next.day && next.day !== dayIn(now, zone) ? t`Next: ${day(next.day, true)} ${next.time} ${rowName(next)}` : t`Next: ${next.time} ${rowName(next)}` }));
  } else if (r?.phase === 'future') {
    // In days, as its dates are: "tomorrow" all day, never "in 13 hours" the evening before. From today's date to its first day, so the words change at midnight, when home draws again.
    const utc = (/** @type {string} */ d) => Date.parse(`${d}T00:00:00Z`);
    more.push(h('span', { class: 'sub soon', text: relTime(utc(s.start), utc(/** @type {string} */ (dayIn(now, zone)))) }));
    const last = await herLast(ctx, s.id);
    if (last.text) more.push(h('span', { class: 'sub her-last', ...hers(last.text, { before: last.before }), text: last.text }));
  }
  const name = scopeTitle(s); // one stored with the draft's name says "New conversation" in the screens' language
  const lit = litOf(r?.phase, stepOf(said));
  const colour = lit ? { style: { '--hue': hueOf(s.created), '--lit': `${lit * 100}%` } } : {};
  return h('li', {}, h('a', { class: ['card', 'trip-card', r?.phase === 'happening' ? 'happening' : '', lit ? 'lit' : ''], ...colour, href: r ? talkHref(s.id) : `#/trip/${encodeURIComponent(s.id)}` },
    h('span', { class: 'trip-card-text' },
      h('span', { class: 'name', ...say(name), text: name }),
      h('span', { class: 'sub' }, ...factsWords([s.start ? dateRange(s.start, s.end) : null, stamps.length ? { stamps: stampCount(stamps.length) } : null, unread ? plural(unread, '# file waiting to be read', '# files waiting to be read') : null, backedUp])),
      madeByLine(s),
      ...more),
    stampMarks(stamps)));
}

/** A trip card's hues on the OKLCH circle (the trip-colour design): ten, 35° apart but for the lime-to-olive band, muddy in dark mode. */
export const HUES = Object.freeze([25, 60, 95, 140, 175, 210, 245, 280, 315, 350]);

/**
 * A trip's own hue, from when it was made: the same at every draw and on every phone, as an import or a restore keeps `created` (and mints a new id,
 * archive.js). MurmurHash3's 32-bit finish: Knuth's one multiplication gave 6 in 10 trips made a minute apart their neighbour's hue. @param {number} created
 */
export function hueOf(created) {
  let x = created >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return HUES[Math.floor((((x ^ (x >>> 16)) >>> 0) / 2 ** 32) * HUES.length)];
}

/**
 * Where each step of the traveller's lines in a trip begins, each four times the last: none, 1-4, 5-19, 20-79, 80 and more. Chosen so that real
 * conversations spread over all five, and a trip talked in daily reaches the top within days. The last is the most a card needs counted: more lines
 * change nothing (linesSaid stops there).
 */
export const STEPS = Object.freeze([1, 5, 20, 80]);

/** @param {number} lines @returns {number} 0 to 4 */
export const stepOf = (lines) => STEPS.filter((n) => lines >= n).length;

/**
 * How lit a trip's card is, 0 (plain) to 1 (its full colour), by phase and step. Happening: its step, never under 3/4, so the trip of now outshines any
 * past one (at most 1/2). Ahead: half its step, never under 1/4 (the user, 2026-11-16: "upcoming trips can get a lighter version"): at 1/4 a new trip
 * ahead is 0.025 OKLab from a plain card in light (0.027 to 0.032 in dark), near the 0.030 (0.034) of the lighter tint it had before, and as the mockup
 * the user picked showed it; at 1/8 it was 0.012 (0.014 to 0.016), under half. Past: half its step, the pastel ("a more pastel color"); unused, plain.
 * Archived (no row) and chats: plain.
 * @param {Row['phase'] | undefined} phase @param {number} step 0 to 4
 */
export function litOf(phase, step) {
  if (phase === 'happening') return Math.max(step / 4, 3 / 4);
  if (phase === 'future') return Math.max(step / 8, 1 / 4);
  return phase === 'past' ? step / 8 : 0;
}

/** Her last line in a conversation, and her reply so far before it. @param {any} ctx @param {string} scope @returns {Promise<{ text: string, before: string[] }>} */
async function herLast(ctx, scope) {
  const [e] = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(scope, { types: ['out.speak'], reverse: true, limit: 1 }));
  if (!e) return { text: '', before: [] };
  return { text: String({ ...e.data, ...(await storedTexts(ctx.store, e)) }.text ?? ''), before: await replyBefore(ctx.store, scope, e).catch(() => []) };
}

/** When the user last talked in `me`, read once a page load: it takes no more lines, but an import can replace it (forgetMeTalked). @type {Promise<number | null> | null} */
let meAt = null;
/** @param {any} store */
const meTalked = (store) => (meAt ??= lastTalked(store, ME).catch(() => { meAt = null; return null; }));
/** An import replaced `me`: its row is read again at the next draw of home, so it is right without a reload. */
export const forgetMeTalked = () => { meAt = null; };

/** What went wrong with a trip's name or dates, in words, for Details. @param {any} err */
export function explainTrip(err) {
  if (!(err instanceof ValidationError)) return messageOf(err);
  if (err.errors.some((m) => m.startsWith('$.title'))) return t`Give it a name.`;
  if (err.errors.some((m) => /date/.test(m))) return t`Use real dates for the start and end.`;
  return err.errors.join(' ');
}
