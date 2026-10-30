import { h, field, t, plural, twoStep, messageOf } from '../dom.js';
import { listTrips, createTrip, backupState, SYS_WAITING } from '../../core/scopes.js';
import { readNames, shortName } from '../../core/names.js';
import { waitingFiles, dropWaiting } from '../../core/waiting.js';
import { filesToRead } from '../../core/handover.js';
import { askAbout, canAsk } from '../composer.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { ValidationError } from '../../core/workspace.js';
import { explainStorageFull } from '../storage-full.js';
import { relTime, dateRange, backupText, wording, size, waitingHref } from '../format.js';
import { requestPersist } from '../platform.js';
import { openFileButton } from '../open-file.js';
import { tripStamps, stampMarks, factsWords } from '../stamps.js';
import { stampCount } from '../../core/after/stamps.js';

/** @param {any} ctx */
export async function renderTrips(ctx) {
  const { active, archived } = await listTrips(ctx.store);
  const settings = await readAppSettings(ctx.ws);
  const places = ctx.backups ? await ctx.backups.list() : [];
  const latest = places.filter((/** @type {any} */ p) => p.last).sort((/** @type {any} */ a, /** @type {any} */ b) => b.last.at - a.last.at)[0];
  const say = wording(settings);
  const cards = await Promise.all(active.map(async (s) => tripCard(s, await ctx.ws.readJSON(s.id, '/trip.json').catch(() => null), await backupState(ctx.store, s.id), await tripStamps(ctx, s.id), say, (await filesToRead(ctx.store, s.id)).length)));
  const archivedCards = await Promise.all(archived.map(async (s) => tripCard(s, null, await backupState(ctx.store, s.id), await tripStamps(ctx, s.id), say, 0)));
  const waiting = await waitingFiles(ctx.ws);
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: t`Trips` }),
    noTrip(ctx),
    active.length ? h('ul', { class: 'cards' }, ...cards) : h('p', { class: 'empty', text: t`No trips yet. Start one below, or open a trip someone sent you.` }),
    waiting.length ? waitingList(ctx, waiting, await readNames(ctx.ws, SYS_WAITING)) : null,
    newTripForm(ctx),
    openFileButton(ctx),
    h('p', { class: 'sub', text: latest ? t`Last backup ${relTime(latest.last.at)}, to ${latest.name}.`
      : settings.lastExportAt ? t`Last export ${relTime(settings.lastExportAt)}.` : t`No backup yet. Export everything from Settings, or set up automatic backups there.` }),
    archived.length
      ? h('details', { class: 'archived' }, h('summary', { text: t`Archived trips (${archived.length})` }), h('ul', { class: 'cards' }, ...archivedCards))
      : null);
}

/**
 * A trip card (spec §16.2): its name and dates, its stamps (spec §13), files waiting to be read there, and when it was last backed up (§4.9).
 * @param {any} s @param {any} trip @param {{ at: number | null, changed: boolean }} backup @param {import('../stamps.js').Stamp[]} stamps
 * @param {ReturnType<typeof wording>} say the name is the user's words: its own language, not the screens'
 * @param {number} unread files Shiori moved or added there that its conversation hasn't read yet (filesToRead)
 */
function tripCard(s, trip, backup, stamps, say, unread) {
  const when = trip?.start ? dateRange(trip.start, trip.end) : null;
  return h('li', {}, h('a', { class: 'card trip-card', href: `#/trip/${encodeURIComponent(s.id)}` },
    h('span', { class: 'trip-card-text' },
      h('span', { class: 'name', ...say(s.title), text: s.title }),
      h('span', { class: 'sub' }, ...factsWords([when, stamps.length ? { stamps: stampCount(stamps.length) } : null, unread ? plural(unread, '# file waiting to be read', '# files waiting to be read') : null, t`updated ${relTime(s.updated)}`, backupText(backup)]))),
    stampMarks(stamps)));
}

/**
 * The way back to the conversation outside any trip, while a trip is open (the user, 2026-10-29: "Add a way back"): what she was
 * handed with no trip open, and what she said of it, are there. @param {any} ctx
 */
function noTrip(ctx) {
  if (!ctx.agent?.target) return null;
  return h('button', {
    class: 'card no-trip', type: 'button',
    onclick: async () => {
      await updateAppSettings(ctx.ws, { activeTrip: null });
      await ctx.agent.open(null).catch(() => {});
      ctx.go('#/talk');
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

/** @param {any} ctx */
function newTripForm(ctx) {
  const title = h('input', { id: 'trip-title', name: 'title', maxlength: '200', autocomplete: 'off', placeholder: t`Big Sur · Thanksgiving` });
  const start = h('input', { id: 'trip-start', name: 'start', type: 'date' });
  const end = h('input', { id: 'trip-end', name: 'end', type: 'date' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  return h('form', {
    class: 'panel',
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      error.hidden = true;
      requestPersist(); // inside the tap, so browsers that ask the user can
      try {
        const id = await createTrip(ctx.ws, { title: title.value, start: start.value || undefined, end: end.value || undefined });
        ctx.go(`#/trip/${encodeURIComponent(id)}`);
      } catch (err) {
        explainStorageFull(ctx, err);
        error.textContent = explain(err);
        error.hidden = false;
      }
    },
  },
  h('h2', { class: 'section', text: t`Start a trip` }),
  field(t`Trip name`, title),
  // A name is enough (goal 3): Shiori fills the dates in from the bookings.
  h('details', { class: 'dates' }, h('summary', { text: t`Add dates (optional)` }), h('div', { class: 'row' }, field(t`Starts`, start), field(t`Ends`, end))),
  error,
  h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, t`Start trip`)));
}

/** @param {any} err */
function explain(err) {
  if (!(err instanceof ValidationError)) return messageOf(err);
  if (err.errors.some((m) => m.startsWith('$.title'))) return t`Give the trip a name.`;
  if (err.errors.some((m) => /date/.test(m))) return t`Use real dates for the start and end.`;
  return err.errors.join(' ');
}
