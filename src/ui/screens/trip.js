import { h, field, twoStep } from '../dom.js';
import { setTripStatus, removeTrip, backupState } from '../../core/scopes.js';
import { ask } from '../ask.js';
import { normPath } from '../../core/paths.js';
import { ValidationError, NotFoundError } from '../../core/workspace.js';
import { explainStorageFull } from '../storage-full.js';
import { relTime, bytes, dateRange, fileHref } from '../format.js';
import { exportPanel } from '../export-panel.js';
import { bringIn } from '../bring-in.js';
import { updateAppSettings } from '../../core/settings.js';
import { packPanel } from '../offline-pack.js';
import { tripStamps, stampMarks, factsWords } from '../stamps.js';
import { stampCount } from '../../core/after/stamps.js';
import { slotEntries } from '../slots.js';

export { fileHref };

/** @param {any} ctx @param {{ parts: string[] }} route */
export async function renderTrip(ctx, route) {
  const id = route.parts[1];
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: "This trip isn't on this device" }), h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips')));
  }
  // Opening a trip makes it the one Shiori talks about (spec §4.3: /trip/ is the active trip).
  if (ctx.agent && ctx.agent.target !== id) {
    updateAppSettings(ctx.ws, { activeTrip: id }).catch(() => {});
    ctx.agent.open(id).catch(() => {});
  }
  const trip = await ctx.ws.readJSON(id, '/trip.json').catch(() => null);
  const files = (await ctx.ws.list(id, '/')).filter((/** @type {any} */ f) => !f.path.startsWith('/offline/')); // the pack has its own panel
  const archived = scope.status === 'archived';
  const stamps = await tripStamps(ctx, id);
  const extra = h('div', {}); // the export panel opens here
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/trips' }, '← Trips')),
    h('h1', { class: 'title', text: scope.title }),
    h('p', { class: 'sub' }, ...factsWords([trip?.start ? dateRange(trip.start, trip.end) : null, archived ? 'Archived' : null, `${files.length} files`, stamps.length ? { stamps: stampCount(stamps.length) } : null])),
    stampMarks(stamps, { max: 24, big: true }),
    h('div', { class: 'acts' },
      h('a', { class: 'btn pri', href: `#/trip/${encodeURIComponent(id)}/plan` }, 'Plan'),
      h('a', { class: 'btn', href: `#/trip/${encodeURIComponent(id)}/recap` }, 'Recap'),
      h('a', { class: 'btn', href: `#/trip/${encodeURIComponent(id)}/replay` }, 'Replay'),
      // Plugins' trip tabs (spec §16.4), each a page of its own.
      ...slotEntries(ctx, 'ui:trip-tab').map((e) => h('a', { class: 'btn', href: `#/trip/${encodeURIComponent(id)}/ext/${encodeURIComponent(e.pluginId)}/${encodeURIComponent(e.item.id)}`, text: String(e.item.title) })),
      ...tripActions(ctx, id, scope, extra),
      archived
        ? h('button', { class: 'btn', type: 'button', onclick: async () => { await setTripStatus(ctx.store, id, 'active'); await ctx.live?.tripsChanged().catch(() => {}); ctx.render(); } }, 'Unarchive')
        // Archived, its reminders leave live mode and the push relay at once.
        : twoStep('Archive trip', 'Tap again to archive', async () => { await setTripStatus(ctx.store, id, 'archived'); await ctx.live?.tripsChanged().catch(() => {}); ctx.go('#/trips'); }),
      h('button', { class: 'btn danger', type: 'button', onclick: (/** @type {Event} */ e) => removeFlow(ctx, id, scope, /** @type {HTMLButtonElement} */ (e.currentTarget)) }, 'Remove trip')),
    extra,
    await packPanel(ctx, id),
    fileList(id, files),
    newFile(ctx, id));
}

/** @param {any} ctx @param {string} id @param {any} scope @param {HTMLElement} slot @returns {HTMLElement[]} */
function tripActions(ctx, id, scope, slot) {
  return [h('button', {
    class: 'btn', type: 'button',
    onclick: () => slot.replaceChildren(...(slot.firstChild ? [] : [exportPanel(ctx, { kind: 'trip', scopes: [id], title: scope.title })])),
  }, 'Export trip')];
}

/**
 * Remove trip (spec §4.9): asks once, and again only when the trip changed after its last Backup.
 * Then the trip is gone from this device and its space is free. The button stays off while it runs.
 * @param {any} ctx @param {string} id @param {any} scope @param {HTMLButtonElement} button
 */
async function removeFlow(ctx, id, scope, button) {
  button.disabled = true;
  try {
    await askAndRemove(ctx, id, scope);
  } finally {
    button.disabled = false;
  }
}

/** @param {any} ctx @param {string} id @param {any} scope */
async function askAndRemove(ctx, id, scope) {
  // What a provider keeps of its conversations goes too, said before the tap (G2).
  const k = await ctx.llm?.keptCount({ scope: id }).catch(() => null);
  const n = k?.turns;
  const kept = n ? ` ${k.who.join(' and ')} keeps ${n} turn${n === 1 ? '' : 's'} of its conversations: annai asks for ${n === 1 ? 'it' : 'them'} to be deleted${navigator.onLine === false ? ", once you're back online" : ''}.` : '';
  const sure = await ask({ title: scope.title, body: `This removes everything in this trip from this device: its files, photos, notes and history.${kept} Remove it?`, yes: 'Remove' });
  if (!sure) return;
  if ((await backupState(ctx.store, id)).changed) {
    const anyway = await ask({ title: 'Not backed up', body: "This trip hasn't been backed up since it last changed. Remove it anyway?", yes: 'Remove anyway' });
    if (!anyway) return;
  }
  try {
    // Shiori leaves the trip first, so nothing more is written into it once it is gone (spec §4.9).
    if (ctx.agent && (ctx.agent.trip === id || ctx.agent.target === id)) {
      await updateAppSettings(ctx.ws, { activeTrip: null });
      await ctx.agent.open(null);
    }
    // Its offline pack's download has ended, its last file written, before the trip goes.
    if (ctx.pack?.running?.scope === id) await ctx.pack.stop();
    const { bytes: freed } = await removeTrip(ctx.store, id);
    // What a provider keeps of its conversations is deleted too, when a connection allows (G2).
    await ctx.llm?.forgetScope(id).catch((/** @type {unknown} */ e) => console.warn("a removed trip's kept turns couldn't be queued for deletion", e));
    // Its reminders leave live mode, and so the push relay, at once (spec §4.9); what was heard in it leaves memory.
    await ctx.live?.forget(id);
    ctx.agent?.voice?.memory.forget(id);
    ctx.notices.toast(`Removed ${scope.title}. ${bytes(freed)} freed.`);
    ctx.go('#/trips');
  } catch (e) {
    if (e instanceof NotFoundError) {
      ctx.notices.toast('That trip was already removed.');
      ctx.go('#/trips');
    } else if (!explainStorageFull(ctx, e)) {
      const why = String(/** @type {any} */ (e)?.message ?? e).replace(/[.!?]?$/, '.');
      ctx.notices.card({ tone: 'warn', title: "That trip wasn't removed", body: `${why} Nothing was removed. Try again.` });
    }
  }
}

/** @param {string} id @param {any[]} files */
function fileList(id, files) {
  if (!files.length) return h('p', { class: 'empty', text: 'No files yet.' });
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const folder = parts.length > 2 ? parts[1] : '';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)?.push(f);
  }
  return h('section', { class: 'files', 'aria-label': 'Files' },
    ...[...groups].map(([folder, list]) => h('div', {},
      h('h2', { class: 'section', text: folder ? `${folder}/` : 'Trip' }),
      h('ul', { class: 'file-list' }, ...list.map((f) => h('li', {}, h('a', { class: 'file-row', href: fileHref(id, f.path) },
        h('span', { class: 'path', text: f.path }),
        h('span', { class: 'sub', text: `${bytes(f.size)} · ${f.author} · ${relTime(f.modified)}` }))))))));
}

/** Starting content for a new file, valid for the core schemas. @param {string} path */
function starter(path) {
  const base = path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'item';
  if (path.startsWith('/plan/') && path.endsWith('.json')) return JSON.stringify({ id: base, title: base, fixed: false }, null, 2) + '\n';
  if (path.startsWith('/bookings/') && path.endsWith('.json')) return JSON.stringify({ id: base, kind: 'other', status: 'unverified', source: '/files/' }, null, 2) + '\n';
  if (path.endsWith('.json')) return '{}\n';
  if (path.endsWith('.md')) return `# ${base}\n`;
  return '';
}

/** @param {any} ctx @param {string} id */
function newFile(ctx, id) {
  const path = h('input', { id: 'new-path', value: '/notes/', autocomplete: 'off', spellcheck: 'false' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const show = (/** @type {any} */ e) => {
    explainStorageFull(ctx, e);
    error.textContent = e instanceof ValidationError ? `That file doesn't match its format: ${e.errors.join('; ')}` : String(e?.message ?? e);
    error.hidden = false;
  };
  const status = h('p', { class: 'sub', role: 'status' });
  /** Adds what was picked, photos through ingest (spec §4.8). @param {HTMLInputElement} input */
  const adder = (input) => async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    error.hidden = true;
    try {
      const { paths, notes, problems, planned } = await bringIn(ctx, id, files, (done, total) => {
        status.textContent = total > 1 && done < total ? `Adding ${done + 1} of ${total}…` : '';
      });
      await ctx.render();
      for (const note of notes) ctx.notices.card({ tone: 'warn', title: 'A photo was kept as it is', body: note });
      for (const problem of problems) ctx.notices.card({ tone: 'warn', title: "A calendar file couldn't be read", body: problem });
      const added = paths.length === 1 ? `Added ${paths[0]}` : `Added ${paths.length} files`;
      ctx.notices.toast(planned.length ? `${added}, and ${planned.length} plan ${planned.length === 1 ? 'item' : 'items'} from the calendar` : added);
    } catch (e) {
      status.textContent = '';
      show(e);
    }
  };
  const upload = h('input', { id: 'upload-file', type: 'file', multiple: true, class: 'visually-hidden' });
  upload.addEventListener('change', adder(upload));
  const camera = h('input', { id: 'take-photo', type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden' });
  camera.addEventListener('change', adder(camera));
  return h('form', {
    class: 'panel',
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      error.hidden = true;
      try {
        const p = normPath(path.value);
        if (await ctx.ws.read(id, p)) throw new Error(`${p} already exists. Open it from the list to edit it.`);
        await ctx.ws.write(id, p, starter(p), { author: 'user' });
        ctx.go(fileHref(id, p));
      } catch (err) {
        show(err);
      }
    },
  },
  h('h2', { class: 'section', text: 'Add a file' }),
  field('File path', path),
  error,
  h('div', { class: 'acts' },
    h('button', { class: 'btn pri', type: 'submit' }, 'Create'),
    h('label', { class: 'btn', for: 'upload-file' }, 'Add photos or files'), upload,
    h('label', { class: 'btn', for: 'take-photo' }, 'Take a photo'), camera),
  status);
}
