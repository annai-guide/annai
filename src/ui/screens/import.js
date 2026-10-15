import { h, field, checkbox, radios } from '../dom.js';
import { openArchive, describeArchive, importArchive, NeedsPassphraseError } from '../../core/archive.js';
import { PassphraseError } from '../../core/archive-crypto.js';
import { takePendingImport } from '../import-state.js';
import { openFileButton } from '../open-file.js';
import { relTime, bytes } from '../format.js';

/** @typedef {{ name: string, bytes: Uint8Array }} Source */

/** @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderImport(ctx, route) {
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
  if (pending) return { name: pending.name, bytes: new Uint8Array(await pending.arrayBuffer()) };
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
    return { name, bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  if (params.inbox) {
    const inbox = await caches.open('annai-inbox');
    const [first] = await inbox.keys();
    if (!first) return null;
    const res = await inbox.match(first);
    await inbox.delete(first);
    if (!res) return null;
    return { name: decodeURIComponent(res.headers.get('X-Annai-Name') ?? 'shared file'), bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  return null;
}

/** @param {any} ctx @param {HTMLElement} body @param {Source} source @param {string} [passphrase] */
async function step(ctx, body, source, passphrase) {
  body.replaceChildren(h('p', { class: 'sub', text: `Reading ${source.name}…` }));
  /** @type {any} */
  let opened;
  try {
    opened = await openArchive(source.bytes, passphrase);
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
          result.plugins ? h('p', { class: 'sub', text: 'Imported plugins arrive switched off. Turn on the ones you trust in Plugins.' }) : null));
      } catch (e) {
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
