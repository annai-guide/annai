import { h, field, checkbox, radios } from '../dom.js';
import { openArchive, describeArchive, importArchive, NeedsPassphraseError } from '../../core/archive.js';
import { PassphraseError } from '../../core/archive-crypto.js';
import { takePendingImport } from '../import-state.js';
import { openFileButton } from '../open-file.js';
import { relTime, bytes } from '../format.js';
import { listTrips } from '../../core/scopes.js';
import { isPhotoType } from '../../core/photos.js';
import { typeForPath } from '../../core/paths.js';
import { addFiles } from '../add-files.js';
import { explainStorageFull } from '../storage-full.js';

/** The file to open. A Blob, never its bytes: archives are read a piece at a time (spec §12.1). @typedef {{ name: string, blob: Blob }} Source */

/** @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderImport(ctx, route) {
  if (route.params.inbox) {
    const photos = await inboxPhotos();
    if (photos.length) return photoInbox(ctx, photos, (await listTrips(ctx.store)).active);
  }
  const body = h('div', { class: 'screen' });
  const screen = h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'Open a trip' }), body);
  /** @type {Source | null} */
  let source;
  try {
    source = await pickSource(route.params);
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

/** @param {Record<string, string>} params @returns {Promise<Source | null>} */
async function pickSource(params) {
  const pending = takePendingImport();
  if (pending) return { name: pending.name, blob: pending };
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
  if (params.inbox) {
    const inbox = await caches.open('annai-inbox');
    const [first] = await inbox.keys();
    if (!first) return null;
    const res = await inbox.match(first);
    await inbox.delete(first);
    if (!res) return null;
    return { name: decodeURIComponent(res.headers.get('X-Annai-Name') ?? 'shared file'), blob: await res.blob() };
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

/** @typedef {{ key: Request, file: File }} InboxPhoto */

/** Photos waiting in the share inbox. They stay there until they are added to a trip. @returns {Promise<InboxPhoto[]>} */
async function inboxPhotos() {
  const inbox = await caches.open('annai-inbox');
  /** @type {InboxPhoto[]} */
  const out = [];
  for (const key of await inbox.keys()) {
    const res = await inbox.match(key);
    if (!res) continue;
    const name = decodeURIComponent(res.headers.get('X-Annai-Name') ?? 'photo');
    const type = res.headers.get('Content-Type') || typeForPath(name);
    if (isPhotoType(type) || isPhotoType(typeForPath(name))) out.push({ key, file: new File([await res.blob()], name, { type }) });
  }
  return out;
}

/** Photos shared from another app (Android's share sheet): choose the trip they belong to. @param {any} ctx @param {InboxPhoto[]} items @param {any[]} trips */
function photoInbox(ctx, items, trips) {
  const what = `${items.length} ${items.length === 1 ? 'photo' : 'photos'}`;
  const status = h('p', { class: 'sub', role: 'status' });
  /** @type {HTMLButtonElement[]} */
  const buttons = trips.map((t) => h('button', { class: 'btn pri', type: 'button', onclick: () => add(t) }, `Add to ${t.title}`));
  /** @param {any} trip */
  async function add(trip) {
    for (const b of buttons) b.disabled = true;
    try {
      const { notes } = await addFiles(ctx, trip.id, items.map((i) => i.file), (done, total) => {
        status.textContent = `Adding ${Math.min(done + 1, total)} of ${total}…`;
      });
      const inbox = await caches.open('annai-inbox');
      for (const i of items) await inbox.delete(i.key);
      ctx.go(`#/trip/${encodeURIComponent(trip.id)}`);
      for (const note of notes) ctx.notices.card({ tone: 'warn', title: 'A photo was kept as it is', body: note });
      ctx.notices.toast(`Added ${what}`);
    } catch (e) {
      explainStorageFull(ctx, e);
      status.textContent = String(/** @type {any} */ (e)?.message ?? e);
      for (const b of buttons) b.disabled = false;
    }
  }
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: `Add ${what}` }),
    trips.length
      ? h('div', { class: 'acts' }, ...buttons)
      : h('p', { class: 'empty' }, 'Start a trip first, then share the photos again. ', h('a', { href: '#/trips' }, 'Go to Trips')),
    status);
}
