import { h, field } from '../dom.js';
import { listTrips, createTrip } from '../../core/scopes.js';
import { readAppSettings } from '../../core/settings.js';
import { ValidationError } from '../../core/workspace.js';
import { relTime, dateRange } from '../format.js';
import { requestPersist } from '../platform.js';
import { openFileButton } from '../open-file.js';

/** @param {any} ctx */
export async function renderTrips(ctx) {
  const { active, archived } = await listTrips(ctx.store);
  const settings = await readAppSettings(ctx.ws);
  const cards = await Promise.all(active.map(async (s) => tripCard(s, await ctx.ws.readJSON(s.id, '/trip.json').catch(() => null))));
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Trips' }),
    active.length ? h('ul', { class: 'cards' }, ...cards) : h('p', { class: 'empty', text: 'No trips yet. Start one below, or open a trip someone sent you.' }),
    newTripForm(ctx),
    openFileButton(ctx),
    h('p', { class: 'sub', text: settings.lastExportAt ? `Last export ${relTime(settings.lastExportAt)}.` : 'No backup yet. You can export everything from Settings.' }),
    archived.length
      ? h('details', { class: 'archived' }, h('summary', { text: `Archived trips (${archived.length})` }), h('ul', { class: 'cards' }, ...archived.map((s) => tripCard(s, null))))
      : null);
}

/** @param {any} s @param {any} trip */
function tripCard(s, trip) {
  const when = trip?.start ? dateRange(trip.start, trip.end) : null;
  return h('li', {}, h('a', { class: 'card', href: `#/trip/${encodeURIComponent(s.id)}` },
    h('span', { class: 'name', text: s.title }),
    h('span', { class: 'sub', text: [when, `updated ${relTime(s.updated)}`].filter(Boolean).join(' · ') })));
}

/** @param {any} ctx */
function newTripForm(ctx) {
  const title = h('input', { id: 'trip-title', name: 'title', maxlength: '200', autocomplete: 'off', placeholder: 'Big Sur · Thanksgiving' });
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
        error.textContent = explain(err);
        error.hidden = false;
      }
    },
  },
  h('h2', { class: 'section', text: 'Start a trip' }),
  field('Trip name', title),
  h('div', { class: 'row' }, field('Starts', start), field('Ends', end)),
  error,
  h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, 'Start trip')));
}

/** @param {any} err */
function explain(err) {
  if (!(err instanceof ValidationError)) return String(err?.message ?? err);
  if (err.errors.some((m) => m.startsWith('$.title'))) return 'Give the trip a name.';
  if (err.errors.some((m) => /date/.test(m))) return 'Use real dates for the start and end.';
  return err.errors.join(' ');
}
