import { h, field, twoStep } from '../dom.js';
import { isTextType } from '../../core/paths.js';
import { text } from '../../core/bytes.js';
import { ValidationError } from '../../core/workspace.js';
import { explainStorageFull } from '../storage-full.js';
import { relTime, bytes } from '../format.js';
import { saveFile } from '../save.js';

/** @type {string | null} */
let objectUrl = null;

/** @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route */
export async function renderFile(ctx, route) {
  const id = route.parts[1];
  const path = route.params.path ?? '';
  const back = `#/trip/${encodeURIComponent(id)}`;
  // Only trips open here: a link must not lead someone into editing their profile or annai's own files.
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: "This trip isn't on this device" }), h('p', {}, h('a', { href: '#/trips' }, 'Back to Trips')));
  }
  const head = [h('p', { class: 'crumbs' }, h('a', { href: back }, '← Back to trip')), h('h1', { class: 'title mono', text: path })];
  const r = await ctx.ws.read(id, path);
  const history = await ctx.ws.history(id, path);
  if (!r) return h('div', { class: 'screen' }, ...head, h('p', { class: 'empty', text: 'This file was deleted. You can bring back a version below.' }), historyView(ctx, id, path, history, null));
  const { entry, bytes: content } = r;
  return h('div', { class: 'screen' }, ...head,
    h('p', { class: 'sub', text: `${entry.type} · ${bytes(entry.size)} · changed by ${entry.author} ${relTime(entry.modified)}` }),
    editor(ctx, id, entry, content),
    historyView(ctx, id, path, history, entry.hash),
    h('div', { class: 'acts' }, twoStep('Delete file', 'Tap again to delete', async () => {
      await ctx.ws.delete(id, path, { author: 'user' });
      ctx.go(back);
    })));
}

/** @param {any} ctx @param {string} id @param {any} entry @param {Uint8Array} content */
function editor(ctx, id, entry, content) {
  if (isTextType(entry.type)) {
    const area = h('textarea', { id: 'file-content', class: 'editor', rows: '16', spellcheck: entry.type === 'text/markdown' ? 'true' : 'false' });
    area.value = text(content);
    const errors = h('ul', { class: 'errors', role: 'alert', hidden: true });
    const save = async () => {
      errors.hidden = true;
      try {
        await ctx.ws.write(id, entry.path, area.value, { author: 'user', type: entry.type });
        await ctx.render();
        ctx.notices.toast('Saved');
      } catch (e) {
        explainStorageFull(ctx, e);
        const lines = e instanceof ValidationError ? e.errors : [String(/** @type {any} */ (e)?.message ?? e)];
        errors.replaceChildren(...lines.map((m) => h('li', { text: m })));
        errors.hidden = false;
      }
    };
    return h('div', { class: 'panel' }, field('Content', area), errors, h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: save }, 'Save')));
  }
  if (entry.type.startsWith('image/')) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (content)], { type: entry.type }));
    return h('figure', { class: 'preview' }, h('img', { src: objectUrl, alt: entry.path }));
  }
  return h('div', { class: 'acts' }, h('button', {
    class: 'btn', type: 'button',
    onclick: () => saveFile(new Blob([/** @type {BlobPart} */ (content)], { type: entry.type }), entry.path.split('/').pop() ?? 'file'),
  }, 'Download'));
}

/** @param {any} ctx @param {string} id @param {string} path @param {any[]} history @param {string | null} current */
function historyView(ctx, id, path, history, current) {
  if (!history.length) return h('p', { class: 'sub', text: 'No earlier versions.' });
  return h('section', { class: 'panel', 'aria-label': 'History' },
    h('h2', { class: 'section', text: 'History' }),
    h('ol', { class: 'history' }, ...history.slice().reverse().map((v) => h('li', {},
      h('span', { text: `${v.type === 'file.delete' ? 'Deleted' : 'Saved'} by ${v.actor} ${relTime(v.ts)}` }),
      v.type === 'file.write' && v.new !== current
        ? h('button', { class: 'btn', type: 'button', onclick: async () => { await ctx.ws.restore(id, path, v.new, { author: 'user' }); await ctx.render(); ctx.notices.toast('Version restored'); } }, 'Restore this version')
        : v.new === current ? h('span', { class: 'sub', text: 'Current' }) : null))));
}
