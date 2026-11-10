import { h, field, t, plural, twoStep, messageOf, whenGone } from '../dom.js';
import { listTrips, createTrip, backupState, scopeTitle, SYS_WAITING } from '../../core/scopes.js';
import { readNames, shortName } from '../../core/names.js';
import { waitingFiles, dropWaiting } from '../../core/waiting.js';
import { filesToRead } from '../../core/handover.js';
import { askAbout, canAsk, openOrTell } from '../composer.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { ValidationError } from '../../core/workspace.js';
import { explainStorageFull } from '../storage-full.js';
import { relTime, relChange, dateRange, backupText, wording, size, waitingHref, talkHref, day, when, rowName } from '../format.js';
import { requestPersist } from '../platform.js';
import { openFileButton } from '../open-file.js';
import { tripStamps, stampMarks, factsWords } from '../stamps.js';
import { stampCount } from '../../core/after/stamps.js';
import { timelineRows, dayOfTrip, recentFrom } from '../../core/timeline.js';
import { upcoming, over } from '../../core/now.js';
import { dayIn, deviceZone, nextDay } from '../../core/time.js';
import { storedTexts } from '../../core/agent/log.js';
import { tripRows } from '../trip-rows.js';
import { nowOf, isField } from '../today.js';

/** @typedef {import('../../core/timeline.js').Row} Row */

/**
 * Home: the timeline of trips and chats (the timeline design), old to new, the trips happening at the now line and only dated trips below it.
 * A tap opens a row's conversation. What a card shows beyond its dates is read for cards alone, so chats cost no reads. The foot keeps, until
 * the later stages, the no-trip card, the waiting panel and Start a trip; then the archived trips, Open a file and the last backup.
 * @param {any} ctx
 */
export async function renderTrips(ctx) {
  if (ctx.moved) tripError = tripTyped.title = tripTyped.start = tripTyped.end = ''; // come to home anew: the form's last error and what was typed in it are not shown again
  const { active, archived } = await listTrips(ctx.store);
  const settings = await readAppSettings(ctx.ws);
  const places = ctx.backups ? await ctx.backups.list() : [];
  const latest = places.filter((/** @type {any} */ p) => p.last).sort((/** @type {any} */ a, /** @type {any} */ b) => b.last.at - a.last.at)[0];
  /** due: when a card's Next stops being next, pushed by the happening cards as they are drawn. @type {number[]} */
  const due = [];
  const o = { say: wording(settings), now: nowOf(ctx.live), zone: ctx.live?.timeZone?.() ?? deviceZone(), due };
  const { above, happening, below } = timelineRows(active, o.now, o.zone);
  const byId = new Map(active.map((s) => [s.id, s]));
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
  const waiting = await waitingFiles(ctx.ws);
  // The last backup's and export's "2 hours ago" change their words too (they say it by the device's clock, not live mode's: due is on live mode's).
  for (const at of [latest?.last.at, settings.lastExportAt]) if (at) due.push(o.now + relChange(at, Date.now()) - Date.now());
  const screen = h('div', { class: 'screen timeline' },
    h('h1', { class: 'title', text: t`Trips` }),
    // The shell scrolls the now line 40% down; with less past than that above it, it sits higher, with no blank space over it (a notice there stays in view).
    h('ul', { class: 'cards rows past' }, ...past),
    h('p', { class: 'now-line' }, h('span', { text: t`Now` })),
    h('ul', { class: 'cards rows ahead' }, ...ahead),
    active.length ? null : h('p', { class: 'empty', text: t`Tap + to talk to Shiori.` }),
    noTrip(ctx),
    waiting.length ? waitingList(ctx, waiting, await readNames(ctx.ws, SYS_WAITING)) : null,
    newTripForm(ctx),
    archived.length
      ? fold('archived', h('summary', { text: t`Archived trips (${archived.length})` }), h('ul', { class: 'cards' }, ...archivedCards))
      : null,
    openFileButton(ctx),
    h('p', { class: 'sub', text: latest ? t`Last backup ${relTime(latest.last.at)}, to ${latest.name}.`
      : settings.lastExportAt ? t`Last export ${relTime(settings.lastExportAt)}.` : t`No backup yet. Export everything from Settings, or set up automatic backups there.` }));
  followClock(ctx, screen, o);
  return screen;
}

/**
 * Home is drawn for an instant: its Next, "Day 3 of 8", which trips are happening, and the "tomorrow" and "2 hours ago" it says go stale as time
 * passes. It draws itself again, in place, at the earliest of the moments they change (one timer: a Next item ends, a shown relative time changes its words,
 * or midnight, where a trip starts or ends and the day count moves; the 1 s is for a timer a hair early) and when annai comes back to the front, which a
 * phone's timers may have slept through. Only while it is the screen shown and its address, and never over the Start a trip form while a field of it
 * has focus: then it waits, and draws once the field is left. What is typed in the form, its folds and the place stay (the redraw is not a
 * move; `tripTyped` and `fold` keep what is typed and what is open).
 * @param {any} ctx @param {HTMLElement} screen @param {{ now: number, zone: string, due: number[] }} o
 */
function followClock(ctx, screen, o) {
  const at = location.hash;
  // What a redraw would lose: the focus of a field of the form (the keyboard would close). A name or dates typed in it are drawn again (tripTyped).
  const typing = () => screen.contains(document.activeElement) && isField(document.activeElement);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const redraw = () => {
    clearTimeout(timer); // one wait at a time, whoever asked
    if (!screen.isConnected || location.hash !== at) return; // gone, or going: a redraw now would send a tap's move back
    // Looked at again in half a second, as the shell's own redraw does: soon after the keyboard goes.
    if (typing()) timer = setTimeout(redraw, 500);
    else ctx.render();
  };
  timer = setTimeout(redraw, Math.max(Math.min(nextDay(o.now, o.zone), ...o.due) - o.now, 0) + 1000);
  const front = () => { if (document.visibilityState === 'visible') redraw(); };
  document.addEventListener('visibilitychange', front);
  whenGone(screen, () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', front);
  });
}

/** Home's folds that are open (a month's, 'archived', the form's 'dates'), kept so while annai runs: Back, or a redraw, finds home as it was. */
const unfolded = new Set();
/** @param {string} key @param {...HTMLElement} parts */
function fold(key, ...parts) {
  const el = h('details', { class: key === 'archived' || key === 'dates' ? key : undefined, open: unfolded.has(key) }, ...parts);
  el.addEventListener('toggle', () => (el.open ? unfolded.add(key) : unfolded.delete(key)));
  return el;
}

/** "October 2026", for a "YYYY-MM". @param {string} key */
const monthName = (key) => when(Date.parse(`${key}-01T00:00:00Z`), 'UTC', { month: 'long', year: 'numeric' });

/**
 * A chat: one line, its name and its time (under a month's heading, its day too); a tap opens its conversation.
 * @param {any} s @param {Row} r @param {{ say: ReturnType<typeof wording>, now: number, zone: string }} o
 */
function chatLine(s, r, { say, now, zone }) {
  const name = scopeTitle(s);
  const monthly = /** @type {string} */ (dayIn(r.at, zone)) < recentFrom(now, zone); // as its heading: by the calendar day, not by 30 times 24 hours
  return h('li', {}, h('a', { class: 'card trip-card line', href: talkHref(s.id) },
    h('span', { class: 'name', ...say(name), text: name }),
    h('span', { class: 'sub', text: when(r.at, zone, { ...(monthly ? { month: 'short', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }) })));
}

/**
 * A trip's card (spec §16.2, the timeline design): its name and dates, its stamps (spec §13), files waiting to be read there, and when it was last
 * backed up (§4.9); happening, tinted, "Day 3 of 8" and its Next; ahead, how soon and her last line there. A tap opens its conversation; an archived
 * one's opens Details, where Unarchive is. @param {any} ctx @param {any} s its record @param {Row | null} r its row; null: archived
 * @param {{ say: ReturnType<typeof wording>, now: number, zone: string, due?: number[] }} o say: the name is the user's words; due: where a Next's end goes: its own language, not the screens'
 */
async function tripCard(ctx, s, r, { say, now, zone, due }) {
  const [backup, stamps, unread] = await Promise.all([backupState(ctx.store, s.id), tripStamps(ctx, s.id), r ? filesToRead(ctx.store, s.id).then((f) => f.length) : 0]);
  // Its "backed up … ago" is on the device's clock, and its moment is its own: the footer line's is another place's (or an export's), and a trip's backup can outlive its place.
  if (backup.at !== null) due?.push(now + relChange(backup.at, Date.now()) - Date.now());
  /** @type {HTMLElement[]} */
  const more = [];
  if (r?.phase === 'happening') {
    const d = dayOfTrip(s, now, zone);
    if (d) more.push(h('span', { class: 'sub day-of', text: t`Day ${d.day} of ${d.of}` }));
    const [next] = upcoming((await tripRows(ctx, s.id).catch(() => ({ rows: [] }))).rows, now, 1);
    if (next) due?.push(over(next));
    if (next) more.push(h('span', { class: 'sub next', dir: 'auto', text: next.day && next.day !== dayIn(now, zone) ? t`Next: ${day(next.day, true)} ${next.time} ${rowName(next)}` : t`Next: ${next.time} ${rowName(next)}` }));
  } else if (r?.phase === 'future') {
    // In days, as its dates are: "tomorrow" all day, never "in 13 hours" the evening before. From today's date to its first day, so the words change at midnight, when home draws again.
    const utc = (/** @type {string} */ d) => Date.parse(`${d}T00:00:00Z`);
    more.push(h('span', { class: 'sub soon', text: relTime(utc(s.start), utc(/** @type {string} */ (dayIn(now, zone)))) }));
    const last = await herLast(ctx, s.id);
    if (last) more.push(h('span', { class: 'sub her-last', ...say(last), text: last }));
  }
  return h('li', {}, h('a', { class: ['card', 'trip-card', r?.phase === 'happening' ? 'happening' : ''], href: r ? talkHref(s.id) : `#/trip/${encodeURIComponent(s.id)}` },
    h('span', { class: 'trip-card-text' },
      h('span', { class: 'name', ...say(s.title), text: s.title }),
      h('span', { class: 'sub' }, ...factsWords([s.start ? dateRange(s.start, s.end) : null, stamps.length ? { stamps: stampCount(stamps.length) } : null, unread ? plural(unread, '# file waiting to be read', '# files waiting to be read') : null, backupText(backup)])),
      ...more),
    stampMarks(stamps)));
}

/** Her last line in a conversation. @param {any} ctx @param {string} scope @returns {Promise<string>} */
async function herLast(ctx, scope) {
  const [e] = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(scope, { types: ['out.speak'], reverse: true, limit: 1 }));
  return e ? String({ ...e.data, ...(await storedTexts(ctx.store, e)) }.text ?? '') : '';
}

/**
 * The way back to the conversation outside any trip, while a trip is open: what she was
 * handed with no trip open, and what she said of it, are there. @param {any} ctx
 */
function noTrip(ctx) {
  if (!ctx.agent?.target) return null;
  return h('button', {
    class: 'card no-trip', type: 'button',
    onclick: async () => {
      await updateAppSettings(ctx.ws, { activeTrip: null });
      if (await openOrTell(ctx, null)) ctx.go('#/talk');
    },
  }, h('span', { class: 'name', text: t`Shiori, no trip` }), h('span', { class: 'sub', text: t`Talk with her outside any trip.` }));
}

/**
 * What the user handed Shiori while no trip was open, waiting for her to file it (My call 3 of the bookings-and-trips design): each
 * file by Shiori's short name (its own name until she gives one, which shows as its title), to open, ask her about, or delete (its space
 * comes back). @param {any} ctx @param {any[]} files @param {Record<string, string>} names the waiting space's
 */
function waitingList(ctx, files, names) {
  return h('section', { class: 'panel waiting', 'aria-labelledby': 'waiting-title' },
    h('h2', { id: 'waiting-title', class: 'section', text: t`Waiting with Shiori` }),
    h('ul', { class: 'file-list' }, ...files.map((f) => {
      const real = f.path.split('/').pop() ?? f.path;
      const name = shortName(names, f.path);
      return h('li', { class: 'waiting-file' },
        h('span', { class: 'path', dir: 'auto', title: name !== real ? real : undefined, text: name }),
        h('span', { class: 'acts' },
          h('a', { class: 'btn', href: waitingHref(f.path) }, t`Open`),
          canAsk(ctx) ? h('button', { class: 'btn', type: 'button', onclick: () => askAbout(ctx, { scope: SYS_WAITING, path: f.path, name }) }, t`Ask Shiori about this`) : null,
          twoStep(t`Delete`, t`Tap again to delete`, async () => {
            const freed = await dropWaiting(ctx.ws, f.path);
            ctx.notices.toast(t`Deleted ${name}. ${size(freed)} freed.`);
            await ctx.render();
          })));
    })));
}

/**
 * What Start a trip last said went wrong, kept as `unfolded` is so a redraw of home (the clock's) draws it again: it goes when the user types into the form,
 * submits again, or leaves home (renderTrips).
 */
let tripError = '';
/**
 * What is typed in Start a trip, kept the same way: a redraw that doesn't wait for it (the shell's, when Shiori opens a trip, which doesn't wait on the kept
 * error) draws it again, so a name or dates typed are never lost to a redraw. It goes when the user leaves home.
 */
const tripTyped = { title: '', start: '', end: '' };

/** @param {any} ctx */
function newTripForm(ctx) {
  const title = h('input', { id: 'trip-title', name: 'title', maxlength: '200', autocomplete: 'off', placeholder: t`Big Sur · Thanksgiving`, value: tripTyped.title });
  const start = h('input', { id: 'trip-start', name: 'start', type: 'date', value: tripTyped.start });
  const end = h('input', { id: 'trip-end', name: 'end', type: 'date', value: tripTyped.end });
  // data-kept: home draws it again itself (tripError), so the shell's redraws need not wait for it to go.
  const error = h('p', { class: 'error', role: 'alert', 'data-kept': '', hidden: !tripError, text: tripError });
  return h('form', {
    class: 'panel',
    oninput: () => { Object.assign(tripTyped, { title: title.value, start: start.value, end: end.value }); tripError = ''; error.hidden = true; },
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      tripError = '';
      error.hidden = true;
      requestPersist(); // inside the tap, so browsers that ask the user can
      try {
        const id = await createTrip(ctx.ws, { title: title.value, start: start.value || undefined, end: end.value || undefined });
        ctx.go(`#/trip/${encodeURIComponent(id)}`);
      } catch (err) {
        explainStorageFull(ctx, err);
        tripError = explainTrip(err);
        error.textContent = tripError;
        error.hidden = false;
      }
    },
  },
  h('h2', { class: 'section', text: t`Start a trip` }),
  field(t`Trip name`, title),
  // A name is enough (goal 3): Shiori fills the dates in from the bookings.
  fold('dates', h('summary', { text: t`Add dates (optional)` }), h('div', { class: 'row' }, field(t`Starts`, start), field(t`Ends`, end))),
  error,
  h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, t`Start trip`)));
}

/** What went wrong with a trip's name or dates, in words, for Start a trip and Details. @param {any} err */
export function explainTrip(err) {
  if (!(err instanceof ValidationError)) return messageOf(err);
  if (err.errors.some((m) => m.startsWith('$.title'))) return t`Give the trip a name.`;
  if (err.errors.some((m) => /date/.test(m))) return t`Use real dates for the start and end.`;
  return err.errors.join(' ');
}
