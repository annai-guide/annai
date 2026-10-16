import { h, field, checkbox, radios } from '../dom.js';
import { openArchive, describeArchive, importArchive, NeedsPassphraseError } from '../../core/archive.js';
import { PassphraseError } from '../../core/archive-crypto.js';
import { takePendingImport, isArchiveName } from '../import-state.js';
import { openFileButton } from '../open-file.js';
import { relTime, bytes } from '../format.js';
import { listTrips } from '../../core/scopes.js';
import { isPhotoType } from '../../core/photos.js';
import { typeForPath } from '../../core/paths.js';
import { bringIn } from '../bring-in.js';
import { explainStorageFull } from '../storage-full.js';

/** The file to open. A Blob, never its bytes: archives are read a piece at a time (spec §12.1). @typedef {{ name: string, blob: Blob }} Source */

/** @typedef {{ key: Request | null, file: File }} InboxFile  key: its entry in the share inbox, if it came that way */

/** @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderImport(ctx, route) {
  /** @type {InboxFile[]} */
  const pending = route.params.inbox ? null : takePendingImport();
  const came = route.params.inbox ? await inboxFiles() : (pending?.files ?? []).map((file) => ({ key: null, file }));
  // A file picked with "Open a trip someone sent you" is an archive whatever its name; anything else is one by its name.
  const archive = (/** @type {InboxFile} */ i) => Boolean(pending?.archive) || isArchiveName(i.file.name);
  const forTrip = came.filter((i) => !archive(i));
  if (forTrip.length) return fileInbox(ctx, forTrip, (await listTrips(ctx.store)).active);
  const body = h('div', { class: 'screen' });
  const screen = h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'Open a trip' }), body);
  /** @type {Source | null} */
  let source;
  try {
    source = await pickSource(route.params, came.filter(archive));
  } catch (e) {
    body.append(h('p', { class: 'error', role: 'alert', text: String(/** @type {any} */ (e)?.message ?? e) }), openFileButton(ctx, 'Choose a file instead'));
    return screen;
  }
  if (!source) {
    body.append(h('p', { class: 'empty', text: 'Choose an annai file (.annai.zip or .annai) to open it.' }), openFileButton(ctx, 'Choose a file'));
    return screen;
  }
  await step(ctx, body, source);
  return screen;
}

/** @param {Record<string, string>} params @param {InboxFile[]} archives @returns {Promise<Source | null>} */
async function pickSource(params, archives) {
  const archive = archives[0];
  if (archive) {
    if (archive.key) await (await caches.open('annai-inbox')).delete(archive.key);
    return { name: archive.file.name, blob: archive.file };
  }
  if (params.url) {
    /** @type {Response} */
    let res;
    try {
      res = await fetch(params.url);
    } catch {
      throw new Error("annai couldn't download that file. The site may not allow other web apps to download it.");
    }
    if (!res.ok) throw new Error(`The download failed (${res.status} ${res.statusText}).`);
    const name = decodeURIComponent(new URL(params.url).pathname.split('/').pop() || 'trip');
    return { name, blob: await res.blob() };
  }
  return null;
}

/** @param {any} ctx @param {HTMLElement} body @param {Source} source @param {string} [passphrase] */
async function step(ctx, body, source, passphrase) {
  body.replaceChildren(h('p', { class: 'sub', text: `Reading ${source.name}…` }));
  /** @type {any} */
  let opened;
  try {
    opened = await openArchive(source.blob, passphrase);
  } catch (e) {
    if (e instanceof NeedsPassphraseError || e instanceof PassphraseError) {
      body.replaceChildren(passphraseForm(ctx, body, source, e instanceof PassphraseError ? e.message : null));
      return;
    }
    body.replaceChildren(h('p', { class: 'error', role: 'alert', text: String(/** @type {any} */ (e)?.message ?? e) }), openFileButton(ctx, 'Choose another file'));
    return;
  }
  body.replaceChildren(preview(ctx, body, opened, await describeArchive(ctx.store, opened)));
}

/** @param {any} ctx @param {HTMLElement} body @param {Source} source @param {string | null} problem */
function passphraseForm(ctx, body, source, problem) {
  const input = h('input', { id: 'import-pass', type: 'password', autocomplete: 'off' });
  return h('form', { class: 'panel', onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); step(ctx, body, source, input.value); } },
    h('p', { text: `${source.name} is encrypted.` }),
    problem ? h('p', { class: 'error', role: 'alert', text: problem }) : null,
    field('Passphrase', input),
    h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'submit' }, 'Unlock')));
}

/** @param {any} ctx @param {HTMLElement} body @param {any} opened @param {any} desc */
function preview(ctx, body, opened, desc) {
  /** @type {Record<string, 'new'|'replace'>} */
  const trips = {};
  const rows = desc.trips.map((/** @type {any} */ t) => {
    trips[t.scope] = 'new';
    return h('li', { class: 'card' },
      h('span', { class: 'name', text: t.title }),
      h('span', { class: 'sub', text: `${t.files} files · ${bytes(t.bytes)}${t.history ? ' · with history' : ''}` }),
      t.existing
        ? radios(`You already have "${t.existingTitle}"`, [['new', 'Add as a new trip'], ['replace', 'Replace mine (yours moves to archived trips)']], 'new', (v) => { trips[t.scope] = /** @type {any} */ (v); })
        : null);
  });
  const me = desc.hasMe ? checkbox('Replace my profile and memory with the ones in this file', false) : null;
  const settings = desc.hasSettings ? checkbox('Replace my settings', false) : null;
  const plugins = desc.hasPlugins ? checkbox('Replace my plugins', false) : null;
  const keys = desc.hasSecrets ? checkbox('Restore API keys (keys already on this device are kept)', false) : null;
  const status = h('p', { class: 'sub', role: 'status' });
  const go = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      go.disabled = true;
      status.textContent = 'Importing…';
      try {
        const result = await importArchive(ctx.store, opened, {
          trips, me: me?.input.checked ? 'replace' : 'keep', settings: settings?.input.checked ? 'replace' : 'keep',
          plugins: plugins?.input.checked ? 'replace' : 'keep', secrets: keys?.input.checked ?? false,
        });
        const titles = desc.trips.map((/** @type {any} */ t) => t.title);
        body.replaceChildren(h('div', { class: 'panel' },
          h('p', { role: 'status', text: 'Imported.' }),
          h('div', { class: 'acts' }, ...result.trips.map((id, i) => h('a', { class: 'btn pri', href: `#/trip/${encodeURIComponent(id)}` }, `Open ${titles[i] ?? 'trip'}`))),
          result.archived.length ? h('p', { class: 'sub', text: `${result.archived.length} older ${result.archived.length === 1 ? 'copy' : 'copies'} moved to archived trips.` }) : null,
          result.settings || result.plugins ? h('p', { class: 'sub', text: 'Restart annai to use the imported settings and plugins.' }) : null,
          result.plugins ? h('p', { class: 'sub', text: 'Imported plugins arrive switched off. Turn on the ones you trust in Plugins.' }) : null,
          result.keptSecrets.length ? h('p', { class: 'sub', text: keptKeys(result.keptSecrets) }) : null));
      } catch (e) {
        explainStorageFull(ctx, e);
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
        go.disabled = false;
      }
    },
  }, 'Import');
  return h('div', { class: 'panel' },
    h('p', { text: `${desc.kind === 'everything' ? 'A backup of everything' : 'A trip'} exported ${relTime(desc.created)} from annai ${desc.app}${desc.encrypted ? ', encrypted' : ''}.` }),
    rows.length ? h('ul', { class: 'cards' }, ...rows) : h('p', { class: 'sub', text: 'There are no trips in this file.' }),
    h('div', { class: 'checks' }, me?.el ?? null, settings?.el ?? null, plugins?.el ?? null, keys?.el ?? null),
    h('div', { class: 'acts' }, go),
    status);
}

/** @param {string[]} ids */
function keptKeys(ids) {
  return ids.length === 1
    ? `Kept your own API key for ${ids[0]}; the one in the file wasn't used.`
    : `Kept your own API keys for ${ids.join(', ')}; the ones in the file weren't used.`;
}

/** Everything waiting in the share inbox. It stays there until it is added to a trip or opened. @returns {Promise<InboxFile[]>} */
async function inboxFiles() {
  const inbox = await caches.open('annai-inbox');
  /** @type {InboxFile[]} */
  const out = [];
  for (const key of await inbox.keys()) {
    const res = await inbox.match(key);
    if (!res) continue;
    const name = decodeURIComponent(res.headers.get('X-Annai-Name') ?? 'shared file');
    const type = (res.headers.get('Content-Type') || typeForPath(name)).split(';')[0].trim();
    out.push({ key, file: new File([await res.blob()], name, { type }) });
  }
  return out;
}

/**
 * Files shared from another app (Android's share sheet) or dropped on annai: the user sees them,
 * then chooses the trip they belong to (spec §7.3, §12.3). A share can come from any site, so
 * nothing is added before that.
 * @param {any} ctx @param {InboxFile[]} items @param {any[]} trips
 */
function fileInbox(ctx, items, trips) {
  const n = items.length;
  const photos = items.filter((i) => isPhotoType(i.file.type) || isPhotoType(typeForPath(i.file.name)));
  const others = items.filter((i) => !photos.includes(i));
  const what = others.length ? (n === 1 ? 'a file' : `${n} files`) : `${n} ${n === 1 ? 'photo' : 'photos'}`;
  const status = h('p', { class: 'sub', role: 'status' });
  /** @type {HTMLButtonElement[]} */
  const buttons = trips.map((t) => h('button', { class: 'btn pri', type: 'button', onclick: () => add(t) }, `Add to ${t.title}`));
  /** @param {any} trip */
  async function add(trip) {
    for (const b of buttons) b.disabled = true;
    try {
      const { notes, problems, planned } = await bringIn(ctx, trip.id, items.map((i) => i.file), (done, total) => {
        status.textContent = `Adding ${Math.min(done + 1, total)} of ${total}…`;
      });
      const inbox = await caches.open('annai-inbox');
      for (const i of items) if (i.key) await inbox.delete(i.key);
      for (const url of urls) URL.revokeObjectURL(url);
      ctx.go(`#/trip/${encodeURIComponent(trip.id)}`);
      for (const note of notes) ctx.notices.card({ tone: 'warn', title: 'A photo was kept as it is', body: note });
      for (const problem of problems) ctx.notices.card({ tone: 'warn', title: "A calendar file couldn't be read", body: problem });
      ctx.notices.toast(`Added ${what}${planned.length ? `, and ${planned.length} plan ${planned.length === 1 ? 'item' : 'items'} from the calendar` : ''}`);
    } catch (e) {
      explainStorageFull(ctx, e);
      status.textContent = String(/** @type {any} */ (e)?.message ?? e);
      for (const b of buttons) b.disabled = false;
    }
  }
  const shown = photos.slice(0, 12);
  const urls = shown.map((i) => URL.createObjectURL(i.file));
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: `Add ${what}` }),
    shown.length ? h('ul', { class: 'thumbs' }, ...shown.map((i, k) => h('li', {}, h('img', { src: urls[k], alt: i.file.name, decoding: 'async' })))) : null,
    photos.length > shown.length ? h('p', { class: 'sub', text: `and ${photos.length - shown.length} more photos` }) : null,
    others.length ? h('ul', { class: 'file-names' }, ...others.map((i) => h('li', { text: `${i.file.name} · ${bytes(i.file.size)}` }))) : null,
    trips.length
      ? h('div', { class: 'acts' }, ...buttons)
      : h('p', { class: 'empty' }, `Start a trip first, then share ${n === 1 ? 'it' : 'them'} again. `, h('a', { href: '#/trips' }, 'Go to Trips')),
    status);
}
