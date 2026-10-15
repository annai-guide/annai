import { h, field, twoStep } from '../dom.js';
import { setTripStatus } from '../../core/scopes.js';
import { normPath, typeForPath } from '../../core/paths.js';
import { ValidationError } from '../../core/workspace.js';
import { explainStorageFull } from '../storage-full.js';
import { relTime, bytes, dateRange } from '../format.js';
import { exportPanel } from '../export-panel.js';

/** @param {string} id @param {string} path */
export const fileHref = (id, path) => `#/trip/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`;

/** @param {any} ctx @param {{ parts: string[] }} route */
export async function renderTrip(ctx, route) {
  const id = route.parts[1];
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: "This trip isn't on this device" }), h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips')));
  }
  const trip = await ctx.ws.readJSON(id, '/trip.json').catch(() => null);
  const files = await ctx.ws.list(id, '/');
  const archived = scope.status === 'archived';
  const extra = h('div', {}); // the export panel opens here
  return h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/trips' }, '← Trips')),
    h('h1', { class: 'title', text: scope.title }),
    h('p', { class: 'sub', text: [trip?.start ? dateRange(trip.start, trip.end) : null, archived ? 'Archived' : null, `${files.length} files`].filter(Boolean).join(' · ') }),
    h('div', { class: 'acts' },
      ...tripActions(ctx, id, scope, extra),
      archived
        ? h('button', { class: 'btn', type: 'button', onclick: async () => { await setTripStatus(ctx.store, id, 'active'); ctx.render(); } }, 'Unarchive')
        : twoStep('Archive trip', 'Tap again to archive', async () => { await setTripStatus(ctx.store, id, 'archived'); ctx.go('#/trips'); })),
    extra,
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
  const upload = h('input', {
    id: 'upload-file', type: 'file', class: 'visually-hidden',
    onchange: async () => {
      const f = upload.files?.[0];
      if (!f) return;
      try {
        const target = normPath(`/files/${f.name}`);
        await ctx.ws.write(id, target, new Uint8Array(await f.arrayBuffer()), { author: 'user', type: f.type || typeForPath(target) });
        await ctx.render();
        ctx.notices.toast(`Added ${target}`);
      } catch (e) {
        show(e);
      }
    },
  });
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
  h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, 'Create'), h('label', { class: 'btn', for: 'upload-file' }, 'Upload a file'), upload));
}
