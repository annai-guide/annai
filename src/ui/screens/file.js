import { h, crumb, t, asUser, field, twoStep, messageOf } from '../dom.js';
import { isTextType } from '../../core/paths.js';
import { text } from '../../core/bytes.js';
import { ValidationError } from '../../core/workspace.js';
import { explainStorageFull } from '../storage-full.js';
import { readAppSettings } from '../../core/settings.js';
import { relTime, size, num, takenText, pathParts, authorName, speaksScreens } from '../format.js';
import { openPhotoViewer } from '../photo-viewer.js';
import { saveFile } from '../save.js';
import { parseHash } from '../router.js';

/** @type {string | null} */
let objectUrl = null;

/** The screens a file's crumb goes back to, when it was opened from one (?from=), by their words; else the trip. */
const BACK = /** @type {Record<string, string>} */ ({ plan: t`Plan`, booking: t`Booking`, now: t`Now` });
/**
 * Where a file opened from: one of BACK's screens, of this trip or the open one's, else null.
 * @param {string | undefined} from @param {string} id @returns {{ hash: string, name: string } | null}
 */
export function cameFrom(from, id) {
  if (!from?.startsWith('#/')) return null;
  const r = parseHash(from);
  return Object.hasOwn(BACK, r.name) && (r.parts[0] !== 'trip' || r.parts[1] === id) ? { hash: from, name: r.name } : null;
}

/** @param {any} ctx @param {{ parts: string[], params: Record<string, string> }} route */
export async function renderFile(ctx, route) {
  const id = route.parts[1];
  const path = route.params.path ?? '';
  // Back is where the file was opened from (Plan → Check this → Open the original, the user, 2026-10-28), else the trip.
  const from = cameFrom(route.params.from, id);
  const back = from?.hash ?? `#/trip/${encodeURIComponent(id)}`;
  // Only trips open here: a link must not lead someone into editing their profile or annai's own files.
  const scope = await ctx.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  if (!scope || scope.kind !== 'trip') {
    return h('div', { class: 'screen' }, h('h1', { class: 'title', text: t`This trip isn't on this device` }), h('p', {}, h('a', { href: '#/trips' }, t`Back to Trips`)));
  }
  const head = [h('p', { class: 'crumbs' }, crumb(back, from ? BACK[from.name] : t`Back to trip`)), h('h1', { class: 'title mono', dir: 'ltr' }, ...pathParts(path))];
  const r = await ctx.ws.read(id, path);
  const history = await ctx.ws.history(id, path);
  if (!r) return h('div', { class: 'screen' }, ...head, h('p', { class: 'empty', text: t`This file was deleted. You can bring back a version below.` }), historyView(ctx, id, path, history, null));
  const { entry, bytes: content } = r;
  return h('div', { class: 'screen' }, ...head,
    h('p', { class: 'sub', text: [entry.type, size(entry.size), changedText(entry)].join(' · ') }),
    editor(ctx, id, entry, content),
    historyView(ctx, id, path, history, entry.hash),
    h('div', { class: 'acts' }, twoStep(t`Delete file`, t`Tap again to delete`, async () => {
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
        ctx.notices.toast(t`Saved`);
      } catch (e) {
        explainStorageFull(ctx, e);
        // A schema's refusals are its English (decision 11), marked so.
        errors.replaceChildren(...(e instanceof ValidationError ? e.errors.map((m) => h('li', { lang: 'en', text: m })) : [h('li', { text: messageOf(e) })]));
        errors.hidden = false;
      }
    };
    return h('div', { class: 'panel' }, field(t`Content`, area), errors, h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: save }, t`Save`)));
  }
  if (entry.type.startsWith('image/')) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const url = (objectUrl = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (content)], { type: entry.type })));
    const img = h('img', { src: url, alt: entry.path });
    const figure = h('figure', { class: 'preview' },
      h('button', {
        class: 'photo', type: 'button', 'aria-label': t`Open the photo full size`,
        // In the trip Shiori is in, the viewer can show her the part on screen (spec §16.2).
        onclick: () => openPhotoViewer(url, entry.path, ctx.agent?.target === id ? {
          onShowPart: async (/** @type {number[]} */ region) => {
            const shown = `/trip${entry.path}`;
            ctx.agent.send(asUser(speaksScreens(await readAppSettings(ctx.ws)))`Look at this part of ${shown}.`, { photos: [{ path: shown, region }] });
            ctx.go('#/talk');
          },
        } : {}),
      }, img),
      photoFacts(entry));
    img.addEventListener('error', () => figure.replaceChildren(
      h('p', { class: 'sub', text: t`This browser can't show this photo. It shows in Safari, and a Share export converts it where it can.` }),
      photoFacts(entry)));
    return figure;
  }
  return h('div', { class: 'acts' }, h('button', {
    class: 'btn', type: 'button',
    onclick: () => saveFile(new Blob([/** @type {BlobPart} */ (content)], { type: entry.type }), entry.path.split('/').pop() ?? 'file'),
  }, t`Download`));
}

/** Size, when and where a photo was taken, and whether it is stored as taken. @param {any} entry */
function photoFacts(entry) {
  const m = entry.meta ?? {};
  const facts = [
    // Pixels as cameras write them: no thousands mark.
    m.width && m.height ? `${num(m.width, { useGrouping: false })} × ${num(m.height, { useGrouping: false })}` : null,
    m.taken ? t`Taken ${takenText(m.taken)}` : null,
    m.original ? t`Stored as taken` : null,
  ].filter(Boolean).join(' · ');
  const map = m.place
    ? h('a', { href: `https://www.openstreetmap.org/?mlat=${m.place.lat}&mlon=${m.place.lng}#map=16/${m.place.lat}/${m.place.lng}`, target: '_blank', rel: 'noopener noreferrer' }, t`Where it was taken`)
    : null;
  return h('figcaption', { class: 'sub' }, facts, facts && map ? ' · ' : null, map);
}

/** @param {any} ctx @param {string} id @param {string} path @param {any[]} history @param {string | null} current */
function historyView(ctx, id, path, history, current) {
  if (!history.length) return h('p', { class: 'sub', text: t`No earlier versions.` });
  return h('section', { class: 'panel', 'aria-label': t`History` },
    h('h2', { class: 'section', text: t`History` }),
    h('ol', { class: 'history' }, ...history.slice().reverse().map((v) => h('li', {},
      h('span', { text: versionText(v) }),
      // A version an import didn't carry has no content here (spec §12.3), and one may be gone: said, never thrown.
      v.type === 'file.write' && !v.new ? h('span', { class: 'sub', text: t`Not kept in this copy` })
        : v.type === 'file.write' && v.new !== current
          ? h('button', { class: 'btn', type: 'button', onclick: async () => {
            try {
              await ctx.ws.restore(id, path, v.new, { author: 'user' });
            } catch {
              ctx.notices.toast(t`That version isn't stored on this device.`);
              return;
            }
            await ctx.render();
            ctx.notices.toast(t`Version restored`);
          } }, t`Restore this version`)
          : v.new === current ? h('span', { class: 'sub', text: t`Current` }) : null))));
}

/** Who changed a file, and when: "you" has its own message, as the words around it change with it. @param {any} entry */
function changedText(entry) {
  const ago = relTime(entry.modified);
  return entry.author === 'user' ? t`changed by you ${ago}` : t`changed by ${authorName(entry.author)} ${ago}`;
}

/** A version in a file's history: saved or deleted, by whom, when. @param {any} v */
function versionText(v) {
  const [mine, who, ago] = [v.actor === 'user', authorName(v.actor), relTime(v.ts)];
  if (v.type === 'file.delete') return mine ? t`Deleted by you ${ago}` : t`Deleted by ${who} ${ago}`;
  return mine ? t`Saved by you ${ago}` : t`Saved by ${who} ${ago}`;
}
