import { h, crumb, t, plural, field, twoStep, linkIn, messageOf } from '../dom.js';
import { setTripStatus, removeTrip, backupState } from '../../core/scopes.js';
import { ask } from '../ask.js';
import { normPath } from '../../core/paths.js';
import { ValidationError, NotFoundError } from '../../core/workspace.js';
import { explainStorageFull } from '../storage-full.js';
import { relTime, size, num, list, sentences, dateRange, fileHref, bookingHref, pathParts, authorName, fileLine, talkHref, formatCost } from '../format.js';
import { fileRows, readTripFiles, deletedFiles, deletesOf } from '../../core/trip-files.js';
import { versionText } from './file.js';
import { exportPanel } from '../export-panel.js';
import { bringIn } from '../bring-in.js';
import { updateAppSettings } from '../../core/settings.js';
import { packPanel } from '../offline-pack.js';
import { tripStamps, stampMarks, factsWords } from '../stamps.js';
import { stampCount } from '../../core/after/stamps.js';
import { RECAP_FILE } from '../../core/after/recap.js';
import { slotEntries } from '../slots.js';
import { openTrip } from '../open-trip.js';
import { explainTrip } from './trips.js';
import { costs } from '../../core/agent/budgets.js';

export { fileHref };

/** @param {any} ctx @param {{ parts: string[] }} route */
export async function renderTrip(ctx, route) {
  const id = route.parts[1];
  // Opening a trip makes it the one Shiori talks about (spec §4.3: /trip/ is the active trip).
  const scope = await openTrip(ctx, id);
  if (!scope) return h('div', { class: 'screen' });
  const trip = await ctx.ws.readJSON(id, '/trip.json').catch(() => null);
  const files = (await ctx.ws.list(id, '/')).filter((/** @type {any} */ f) => !f.path.startsWith('/offline/')); // the pack has its own panel
  const archived = scope.status === 'archived';
  const stamps = await tripStamps(ctx, id);
  const extra = h('div', {}); // the export panel opens here
  const { total } = await costs(ctx.store, id);
  // Details, the trip's page: back to its conversation; its name and dates; what opens from it; Share, Archive and Remove; its cost and files.
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, crumb(talkHref(id), t`Conversation`)),
    h('h1', { class: 'title', dir: 'auto', text: scope.title }),
    h('p', { class: 'sub' }, ...factsWords([trip?.start ? dateRange(trip.start, trip.end) : null, archived ? t`Archived` : null, plural(files.length, '# file', '# files'), stamps.length ? { stamps: stampCount(stamps.length) } : null])),
    stampMarks(stamps, { max: 24, big: true }),
    editForm(ctx, id, String(trip?.title ?? scope.title), trip),
    h('div', { class: 'acts' },
      h('a', { class: 'btn pri', href: `#/trip/${encodeURIComponent(id)}/plan` }, t`Itinerary`),
      // A recap and a replay are of days: an undated trip has none yet, but one that has its recap still shows it.
      ...(trip?.start || files.some((/** @type {any} */ f) => f.path === RECAP_FILE) ? [h('a', { class: 'btn', href: `#/trip/${encodeURIComponent(id)}/recap` }, t`Recap`)] : []),
      ...(trip?.start ? [h('a', { class: 'btn', href: `#/trip/${encodeURIComponent(id)}/replay` }, t`Replay`)] : []),
      // Plugins' trip tabs (spec §16.4), each a page of its own.
      ...slotEntries(ctx, 'ui:trip-tab').map((e) => h('a', { class: 'btn', href: `#/trip/${encodeURIComponent(id)}/ext/${encodeURIComponent(e.pluginId)}/${encodeURIComponent(e.item.id)}`, text: String(e.item.title) })),
      ...tripActions(ctx, id, scope, extra),
      archived
        ? h('button', { class: 'btn', type: 'button', onclick: async () => { await setTripStatus(ctx.store, id, 'active'); await ctx.live?.tripsChanged().catch(() => {}); ctx.render(); } }, t`Unarchive`)
        // Archived, its reminders leave live mode and the push relay at once.
        : twoStep(t`Archive trip`, t`Tap again to archive`, async () => { await setTripStatus(ctx.store, id, 'archived'); await ctx.live?.tripsChanged().catch(() => {}); ctx.go('#/trips'); }),
      h('button', { class: 'btn danger', type: 'button', onclick: (/** @type {Event} */ e) => removeFlow(ctx, id, scope, /** @type {HTMLButtonElement} */ (e.currentTarget)) }, t`Remove trip`)),
    extra,
    h('p', { class: 'sub trip-cost', text: t`This trip so far: ${formatCost(total)}` }),
    await filesSection(ctx, id),
    await packPanel(ctx, id),
    // Every file by folder, and the box that adds one by path: the full list, folded below the everyday one.
    allFiles(id, fileList(id, files), newFile(ctx, id)));
}

/**
 * The trip's name and dates, changed here. A date left blank is taken out of trip.json (a merge patch's null), never written as '',
 * which its format refuses; a blank name, or an end before the start, is said and nothing is written.
 * @param {any} ctx @param {string} id @param {string} title @param {any} trip its trip.json
 */
function editForm(ctx, id, title, trip) {
  const name = h('input', { id: 'trip-edit-title', name: 'title', maxlength: '200', autocomplete: 'off', value: title });
  const start = h('input', { id: 'trip-edit-start', name: 'start', type: 'date', value: typeof trip?.start === 'string' ? trip.start : '' });
  const end = h('input', { id: 'trip-edit-end', name: 'end', type: 'date', value: typeof trip?.end === 'string' ? trip.end : '' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const say = (/** @type {string} */ why) => {
    error.textContent = why;
    error.hidden = false;
  };
  /** @type {Record<string, string>} */
  const drawn = { title: name.value, start: start.value, end: end.value };
  return h('form', {
    class: 'panel trip-edit',
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      error.hidden = true;
      const clean = name.value.trim();
      if (!clean) return say(t`Give the trip a name.`);
      if (start.value && end.value && end.value < start.value) return say(t`The trip can't end before it starts.`);
      // Only what was changed here: Shiori may have written the name or the dates since this was drawn.
      const changed = Object.fromEntries(Object.entries({ title: clean, start: start.value, end: end.value }).filter(([k, v]) => v !== drawn[k]).map(([k, v]) => [k, v || null]));
      try {
        await ctx.ws.patch(id, '/trip.json', changed, { author: 'user' });
        ctx.notices.toast(t`Saved.`);
        await ctx.render();
      } catch (err) {
        explainStorageFull(ctx, err);
        say(explainTrip(err));
      }
    },
  },
  field(t`Name`, name),
  h('div', { class: 'row' }, field(t`Starts`, start), field(t`Ends`, end)),
  error,
  h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, t`Save`)));
}

/** The trips whose All files is open, kept while annai runs: adding a file redraws the screen, and the fold stays as it was. */
const unfolded = new Set();
/** @param {string} id @param {...HTMLElement} parts */
function allFiles(id, ...parts) {
  return fold('all-files', t`All files`, unfolded, id, parts);
}

/** The trips whose Deleted is open, kept so: Back from a deleted file finds it as it was. */
const deletedOpen = new Set();
/**
 * A fold of the trip screen that stays open or shut while annai runs. @param {string} cls @param {string} label @param {Set<string>} open
 * @param {string} id @param {HTMLElement[]} parts
 */
function fold(cls, label, open, id, parts) {
  const el = h('details', { class: cls, open: open.has(id) }, h('summary', { text: label }), ...parts);
  el.addEventListener('toggle', () => (el.open ? open.add(id) : open.delete(id)));
  return el;
}

/**
 * The trip's Files (the file-details design, goal 1): one row per file the user gave, by Shiori's short name with what it is beneath;
 * the whole row opens the file's details. Photos are the trip's photos, not listed here. At its foot, the user adds photos or files by
 * hand. @param {any} ctx @param {string} id
 */
async function filesSection(ctx, id) {
  const all = await readTripFiles(ctx.ws, ctx.store, id);
  const rows = fileRows(all);
  const from = `#/trip/${encodeURIComponent(id)}`;
  // Files deleted and kept, as the conversation still names them: each opens its deleted-file screen, with Restore.
  const gone = deletedFiles(await deletesOf(ctx.store, id), all.files);
  return h('section', { class: 'trip-files', 'aria-label': t`Files` },
    h('h2', { class: 'section', text: t`Files` }),
    rows.length ? h('ul', { class: 'file-list' }, ...rows.map((r) => h('li', { class: 'trip-file' },
      h('a', { class: 'file-row', href: bookingHref(id, r.path, from) },
        h('span', { class: 'name', dir: 'auto', text: r.name }),
        h('span', { class: 'sub became', text: fileLine(r.became) }),
        h('span', { class: 'go', 'aria-hidden': 'true', text: '›' }))))) : h('p', { class: 'empty', text: t`No files yet.` }),
    adders(ctx, id),
    gone.length ? fold('deleted-files', t`Deleted (${num(gone.length)})`, deletedOpen, id, [h('ul', { class: 'file-list' }, ...gone.map((g) => h('li', { class: 'trip-file' },
      h('a', { class: 'file-row', href: fileHref(id, g.path, from) },
        h('span', { class: 'name', dir: 'auto', text: g.name }),
        h('span', { class: 'sub became', text: versionText({ type: 'file.delete', actor: g.actor, ts: g.ts }) }),
        h('span', { class: 'go', 'aria-hidden': 'true', text: '›' })))))]) : null);
}

/** @param {any} ctx @param {string} id @param {any} scope @param {HTMLElement} slot @returns {HTMLElement[]} */
function tripActions(ctx, id, scope, slot) {
  return [h('button', {
    class: 'btn', type: 'button',
    onclick: () => slot.replaceChildren(...(slot.firstChild ? [] : [exportPanel(ctx, { kind: 'trip', scopes: [id], title: scope.title })])),
  }, t`Export trip`)];
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

/**
 * Removes a trip for good, as Remove trip does once the user has said yes (spec §4.9): Shiori leaves it first, its offline pack stops,
 * then it goes with everything only it named, and what a provider, live mode and her memory keep of it goes too. Undo of a trip she
 * started uses it with no question: the user asked for it by tapping Undo.
 * @param {any} ctx @param {string} id @returns {Promise<{ title: string, bytes: number }>}
 */
export async function removeTripNow(ctx, id) {
  // Shiori leaves the trip first, so nothing more is written into it once it is gone (spec §4.9).
  if (ctx.agent && (ctx.agent.trip === id || ctx.agent.target === id)) {
    await updateAppSettings(ctx.ws, { activeTrip: null });
    await ctx.agent.open(null, { quiet: true });
  }
  // Its offline pack's download has ended, its last file written, before the trip goes.
  if (ctx.pack?.running?.scope === id) await ctx.pack.stop();
  const removed = await removeTrip(ctx.store, id);
  // What a provider keeps of its conversations is deleted too, when a connection allows (G2).
  await ctx.llm?.forgetScope(id).catch((/** @type {unknown} */ e) => console.warn(/* en */ "a removed trip's kept turns couldn't be queued for deletion", e));
  // Its reminders leave live mode, and so the push relay, at once (spec §4.9); what was heard in it leaves memory.
  await ctx.live?.forget(id);
  ctx.agent?.voice?.memory.forget(id);
  return removed;
}

/** @param {any} ctx @param {string} id @param {any} scope */
async function askAndRemove(ctx, id, scope) {
  // What a provider keeps of its conversations goes too, said before the tap (G2).
  const k = await ctx.llm?.keptCount({ scope: id }).catch(() => null);
  const n = k?.turns;
  const who = n ? list(k.who) : '';
  const kept = !n ? ''
    : navigator.onLine === false
      ? plural(n, "{0} keeps # turn of its conversations: annai asks for it to be deleted, once you're back online.", "{0} keeps # turns of its conversations: annai asks for them to be deleted, once you're back online.", who)
      : plural(n, '{0} keeps # turn of its conversations: annai asks for it to be deleted.', '{0} keeps # turns of its conversations: annai asks for them to be deleted.', who);
  const sure = await ask({ title: scope.title, body: sentences(t`This removes everything in this trip from this device: its files, photos, notes and history.`, kept, t`Remove it?`), yes: t`Remove` });
  if (!sure) return;
  if ((await backupState(ctx.store, id)).changed) {
    const anyway = await ask({ title: t`Not backed up`, body: t`This trip hasn't been backed up since it last changed. Remove it anyway?`, yes: t`Remove anyway` });
    if (!anyway) return;
  }
  try {
    const { bytes: freed } = await removeTripNow(ctx, id);
    ctx.notices.toast(t`Removed ${scope.title}. ${size(freed)} freed.`);
    ctx.go('#/trips');
  } catch (e) {
    if (e instanceof NotFoundError) {
      ctx.notices.toast(t`That trip was already removed.`);
      ctx.go('#/trips');
    } else if (!explainStorageFull(ctx, e)) {
      const why = messageOf(e).replace(/[.!?]?$/, '.');
      ctx.notices.card({ tone: 'warn', title: t`That trip wasn't removed`, body: sentences(why, t`Nothing was removed. Try again.`) });
    }
  }
}

/** @param {string} id @param {any[]} files */
function fileList(id, files) {
  if (!files.length) return h('p', { class: 'empty', text: t`No files yet.` });
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const folder = parts.length > 2 ? parts[1] : '';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)?.push(f);
  }
  return h('section', { class: 'files', 'aria-label': t`All files` },
    ...[...groups].map(([folder, list]) => h('div', {},
      h('h2', { class: 'section', dir: folder ? 'auto' : null, text: folder ? `${folder}/` : t`Trip` }),
      h('ul', { class: 'file-list' }, ...list.map((f) => h('li', {}, h('a', { class: 'file-row', href: fileHref(id, f.path) },
        h('span', { class: 'path', dir: 'ltr' }, ...pathParts(f.path)),
        h('span', { class: 'sub', text: [size(f.size), authorName(f.author), relTime(f.modified)].join(' · ') }))))))));
}

/** Starting content for a new file, valid for the core schemas. @param {string} path */
function starter(path) {
  const base = path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'item';
  if (path.startsWith('/plan/') && path.endsWith('.json')) return JSON.stringify({ id: base, title: base, fixed: false }, null, 2) + '\n';
  if (path.startsWith('/bookings/') && path.endsWith('.json')) return JSON.stringify({ id: base, kind: 'other', status: 'unverified', source: '/files/', unsure: [] }, null, 2) + '\n';
  if (path.endsWith('.json')) return '{}\n';
  if (path.endsWith('.md')) return `# ${base}\n`;
  return '';
}

/**
 * Adds photos or files by hand, photos through ingest (spec §4.8), Shiori woken to read them (bringIn): the foot of Files.
 * @param {any} ctx @param {string} id
 */
function adders(ctx, id) {
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const status = h('p', { class: 'sub', role: 'status' });
  /** Adds what was picked. @param {HTMLInputElement} input */
  const adder = (input) => async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    error.hidden = true;
    try {
      const { paths, notes, problems, planned } = await bringIn(ctx, id, files, (done, total) => {
        status.textContent = total > 1 && done < total ? t`Adding ${num(done + 1)} of ${num(total)}…` : '';
      });
      await ctx.render();
      for (const note of notes) ctx.notices.card({ tone: 'warn', title: t`A photo was kept as it is`, body: note });
      for (const problem of problems) ctx.notices.card({ tone: 'warn', title: t`A calendar file couldn't be read`, body: problem });
      const what = paths.length === 1 ? paths[0] : plural(paths.length, '# file', '# files');
      ctx.notices.toast(planned.length ? plural(planned.length, 'Added {0}, and # itinerary item from the calendar', 'Added {0}, and # itinerary items from the calendar', what)
        : paths.length === 1 ? t`Added ${what}` : plural(paths.length, 'Added # file', 'Added # files'));
    } catch (e) {
      status.textContent = '';
      explainStorageFull(ctx, e);
      error.replaceChildren(messageOf(e));
      error.hidden = false;
    }
  };
  const upload = h('input', { id: 'upload-file', type: 'file', multiple: true, class: 'visually-hidden' });
  upload.addEventListener('change', adder(upload));
  const camera = h('input', { id: 'take-photo', type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden' });
  camera.addEventListener('change', adder(camera));
  return h('div', { class: 'adders' },
    h('div', { class: 'acts' },
      h('label', { class: 'btn', for: 'upload-file' }, t`Add photos or files`), upload,
      h('label', { class: 'btn', for: 'take-photo' }, t`Take a photo`), camera),
    status, error);
}

/** The box that adds a file by its path, with a starter for its format. @param {any} ctx @param {string} id */
function newFile(ctx, id) {
  const path = h('input', { id: 'new-path', value: '/notes/', autocomplete: 'off', spellcheck: 'false' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const show = (/** @type {any} */ e) => {
    explainStorageFull(ctx, e);
    // A schema's refusal is its English (decision 11), marked so.
    const why = e instanceof ValidationError ? e.errors.join('; ') : '';
    error.replaceChildren(...(why ? linkIn(t`That file doesn't match its format: ${why}`, h('span', { lang: 'en', text: why })) : [messageOf(e)]));
    error.hidden = false;
  };
  return h('form', {
    class: 'panel',
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      error.hidden = true;
      try {
        const p = normPath(path.value);
        if (await ctx.ws.read(id, p)) throw new Error(t`${p} already exists. Open it from the list to edit it.`);
        await ctx.ws.write(id, p, starter(p), { author: 'user' });
        ctx.go(fileHref(id, p));
      } catch (err) {
        show(err);
      }
    },
  },
  h('h2', { class: 'section', text: t`Add a file` }),
  field(t`File path`, path),
  error,
  h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, t`Create`)));
}
