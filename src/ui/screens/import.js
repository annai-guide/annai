import { h, field, checkbox, radios } from '../dom.js';
import { peekArchive, describeArchive, importArchive, NeedsPassphraseError } from '../../core/archive.js';
import { PassphraseError } from '../../core/archive-crypto.js';
import { takePendingImport, setPendingImport, isArchiveName, leaveSignal, toldIfLeft } from '../import-state.js';
import { openFileButton } from '../open-file.js';
import { relTime, bytes, placeHref, gettingFiles } from '../format.js';
import { listTrips } from '../../core/scopes.js';
import { isPhotoType } from '../../core/photos.js';
import { typeForPath } from '../../core/paths.js';
import { bringIn } from '../bring-in.js';
import { explainStorageFull } from '../storage-full.js';
import { restartAnnai } from './plugins.js';
import { keepUiFrom } from '../languages.js';

/** The file to open. A Blob, never its bytes: archives are read a piece at a time (spec §12.1). @typedef {{ name: string, blob: Blob, from?: import('../import-state.js').From | null }} Source
 *   from: the backup place it came from (spec §12.4) */

/** @typedef {{ key: Request | null, file: File }} InboxFile  key: its entry in the share inbox, if it came that way */

/** @param {any} ctx @param {{ params: Record<string, string> }} route */
export async function renderImport(ctx, route) {
  const pending = route.params.inbox ? null : takePendingImport();
  /** @type {InboxFile[]} */
  const came = route.params.inbox ? await inboxFiles() : (pending?.files ?? []).map((file) => ({ key: null, file }));
  // A file picked with "Open a trip someone sent you" is an archive whatever its name; anything else is one by its name.
  const archive = (/** @type {InboxFile} */ i) => Boolean(pending?.archive) || isArchiveName(i.file.name);
  const forTrip = came.filter((i) => !archive(i));
  if (forTrip.length) return fileInbox(ctx, forTrip, (await listTrips(ctx.store)).active, came.filter(archive));
  const body = h('div', { class: 'screen' });
  // A way back without importing: to the backup place it came from, else Trips; the preview has Cancel too.
  const from = pending?.from;
  const place = from ? await ctx.backups?.get(from.target).catch(() => null) : null;
  const screen = h('div', { class: 'screen' },
    h('p', { class: 'crumbs' }, h('a', { href: leave(from) }, `← ${from ? place?.name ?? 'Backups' : 'Trips'}`)),
    h('h1', { class: 'title', text: 'Open a trip' }), body);
  // A backup a git place told by its manifest alone shows at once; its files come when the user imports.
  if (pending?.peeked && from) {
    openPeeked(ctx, body, pending.peeked, from).catch((e) => body.replaceChildren(h('p', { class: 'error', role: 'alert', text: String(e?.message ?? e) }), openFileButton(ctx, 'Choose a file instead')));
    return screen;
  }
  /** @type {Source | null} */
  let source;
  try {
    source = await pickSource(route.params, came.filter(archive));
    if (source && pending?.from) source = { ...source, from: pending.from };
  } catch (e) {
    body.append(h('p', { class: 'error', role: 'alert', text: String(/** @type {any} */ (e)?.message ?? e) }), openFileButton(ctx, 'Choose a file instead'));
    return screen;
  }
  if (!source) {
    body.append(h('p', { class: 'empty', text: 'Choose an annai file (.annai.zip or .annai) to open it.' }), openFileButton(ctx, 'Choose a file'));
    return screen;
  }
  // The screen draws at once, saying what it is reading; the preview replaces that when the file's manifest is read.
  step(ctx, body, source).catch((e) => body.replaceChildren(h('p', { class: 'error', role: 'alert', text: String(e?.message ?? e) }), openFileButton(ctx, 'Choose another file')));
  return screen;
}

/** Where leaving the import screen goes. @param {import('../import-state.js').From | null | undefined} from */
const leave = (from) => (from ? placeHref(from.target) : '#/trips');

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
    opened = await peekArchive(source.blob, passphrase);
  } catch (e) {
    if (e instanceof NeedsPassphraseError || e instanceof PassphraseError) {
      body.replaceChildren(passphraseForm(ctx, body, source, e instanceof PassphraseError ? e.message : null));
      return;
    }
    body.replaceChildren(h('p', { class: 'error', role: 'alert', text: String(/** @type {any} */ (e)?.message ?? e) }), openFileButton(ctx, 'Choose another file'));
    return;
  }
  const { active, archived } = await listTrips(ctx.store);
  body.replaceChildren(preview(ctx, body, opened, await describeArchive(ctx.store, opened), source.from ?? null, !active.length && !archived.length));
}

/**
 * The preview of a backup from its manifest alone (spec §12.4: a git place peeks). Nothing else of the backup is sent until Import.
 * @param {any} ctx @param {HTMLElement} body @param {any} manifest @param {import('../import-state.js').From} from
 */
async function openPeeked(ctx, body, manifest, from) {
  const { active, archived } = await listTrips(ctx.store);
  const desc = await describeArchive(ctx.store, { manifest });
  body.replaceChildren(preview(ctx, body, null, desc, from, !active.length && !archived.length, filesOf(ctx, manifest, from)));
}

/**
 * Gets a previewed backup's files, up to six at a time (the place does that), and opens them. The archive must carry the manifest
 * that was previewed: the choices on the preview name its trips, and each file is checked against the manifest as it is imported.
 * @param {any} ctx @param {any} manifest @param {import('../import-state.js').From} from
 * @returns {(say: (words: string) => void, signal: AbortSignal) => Promise<any>}
 */
function filesOf(ctx, manifest, from) {
  const shown = JSON.stringify(manifest);
  return async (say, signal) => {
    let said = 0;
    const off = ctx.backups.on(() => {
      const p = ctx.backups.progress(from.target);
      if (p?.phase !== 'downloading' || (Date.now() - said < 1000 && p.done < p.total)) return;
      said = Date.now();
      say(gettingFiles(p));
    });
    try {
      const downloading = ctx.backups.download(from.target, from.remote.id, { signal });
      say(ctx.backups.running().some((/** @type {any} */ r) => r.reason === 'user') ? "Waiting for the backup that's running to finish…" : gettingFiles(null));
      const opened = await peekArchive(await downloading);
      if (JSON.stringify(opened.manifest) !== shown) throw new Error('This backup changed on the server while annai was getting it. Open it again from the backups.');
      return opened;
    } finally {
      off();
    }
  };
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

/**
 * @param {any} ctx @param {HTMLElement} body @param {any} opened @param {any} desc
 * @param {import('../import-state.js').From | null} from the backup place it came from
 * @param {boolean} fresh this device has no trips yet: restoring onto it brings the profile and settings too
 * @param {((say: (words: string) => void, signal: AbortSignal) => Promise<any>) | null} [bring] a preview from a manifest alone has no archive (opened is null):
 *   this gets the files when the user imports, saying how far it is, and gives the archive; its signal stops it when the user leaves
 */
function preview(ctx, body, opened, desc, from, fresh, bring = null) {
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
  const me = desc.hasMe ? checkbox('Replace my profile and memory with the ones in this file', Boolean(from) && fresh) : null;
  const settings = desc.hasSettings ? checkbox('Replace my settings', Boolean(from) && fresh) : null;
  const plugins = desc.hasPlugins ? checkbox('Replace my plugins', false) : null;
  const keys = desc.hasSecrets ? checkbox('Restore API keys (keys already on this device are kept)', false) : null;
  const status = h('p', { class: 'sub', role: 'status' });
  // Leaving this screen any way (Cancel, the crumb, Back, the dock, a swipe) is a Cancel: the download stops and nothing is imported.
  const leaving = leaveSignal();
  const quit = { signal: leaving.signal, abort: leaving.abort };
  const go = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      go.disabled = true;
      status.textContent = 'Reading…';
      let said = 0;
      try {
        const archive = bring ? await bring((words) => { status.textContent = words; }, quit.signal) : opened;
        quit.signal.throwIfAborted();
        status.textContent = 'Reading…';
        const result = await importArchive(ctx.store, archive, {
          trips, me: me?.input.checked ? 'replace' : 'keep', settings: settings?.input.checked ? 'replace' : 'keep',
          plugins: plugins?.input.checked ? 'replace' : 'keep', secrets: keys?.input.checked ?? false, signal: quit.signal,
          // A live region: said at most once a second, so a screen reader doesn't chatter through hundreds of entries.
          onProgress: (done, total) => {
            if (Date.now() - said < 1000 && done < total) return;
            said = Date.now();
            status.textContent = `Reading ${Math.min(done + 1, total)} of ${total}…`;
          },
        });
        // This device has taken in that backup: its next backup there builds on it (spec §12.4).
        if (from) await ctx.backups?.accept(from.target, from.remote).catch(() => {});
        // Live mode takes in the trips that came and lets go of those archived (their reminders leave the relay).
        if (result.trips.length || result.archived.length) await ctx.live?.tripsChanged().catch(() => {});
        // The plugins the providers that came use, in the same step (spec §12.3).
        if (result.settings) status.textContent = 'Installing the plugins your providers use…';
        // The screens' language came with the settings: its copy for the start is written before the restart (design, section 2).
        if (result.settings) await keepUiFrom(ctx.ws).catch(() => {});
        const plugged = result.settings && ctx.llm ? pluginsBrought(ctx, await restorePlugins(ctx, result.plugins), result.plugins) : null;
        const titles = desc.trips.map((/** @type {any} */ t) => t.title);
        // The import is over: nothing is listening for the user's leaving, and one who left in its last step is told by a toast.
        leaving.done();
        toldIfLeft(ctx, quit.signal, titles, from ? (await ctx.backups?.get(from.target).catch(() => null))?.name : null);
        body.replaceChildren(h('div', { class: 'panel' },
          h('p', { role: 'status', text: 'Imported.' }),
          h('div', { class: 'acts' }, ...result.trips.map((id, i) => h('a', { class: 'btn pri', href: `#/trip/${encodeURIComponent(id)}` }, `Open ${titles[i] ?? 'trip'}`))),
          result.archived.length ? h('p', { class: 'sub', text: `${result.archived.length} older ${result.archived.length === 1 ? 'copy' : 'copies'} moved to archived trips.` }) : null,
          plugged,
          result.settings || result.plugins ? restartPanel(ctx) : null,
          result.plugins ? h('p', { class: 'sub', text: 'Imported plugins arrive switched off. Turn on the ones you trust in Plugins.' }) : null,
          result.keptSecrets.length ? h('p', { class: 'sub', text: keptKeys(result.keptSecrets) }) : null,
          from ? h('p', { class: 'sub', text: "annai's next backup to that place builds on this one." }) : null));
      } catch (e) {
        if (quit.signal.aborted) return; // the user is gone: nothing was imported, and there is no one to tell
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
    h('div', { class: 'acts' }, go, h('a', { class: 'btn', href: leave(from), onclick: () => quit.abort() }, 'Cancel')),
    status);
}

/**
 * The imported settings and plugins are used from the next start: the sentence, and the button that does it. A restart loads the
 * page again at its address, and this screen has nothing left to open then, so annai goes to Trips first, and starts there, where what came in is
 * (the third emulator pass). @param {any} ctx
 */
function restartPanel(ctx) {
  const b = h('button', {
    class: 'btn pri', type: 'button',
    onclick: () => {
      b.disabled = true;
      b.textContent = 'Restarting…';
      ctx.go('#/trips');
      restartAnnai(ctx);
    },
  }, 'Restart annai');
  return h('div', {}, h('p', { class: 'sub', text: 'Restart annai to use the imported settings and plugins.' }), h('div', { class: 'acts' }, b));
}

/** imported: the plugins came with it, switched off. @param {any} ctx @param {boolean} imported @returns {Promise<{ installed: string[], failed: string[] }>} */
const restorePlugins = (ctx, imported) => ctx.llm.restorePlugins({ imported }).catch((/** @type {any} */ e) => ({ installed: [], failed: [String(e?.message ?? e)] }));

/** What the restore installed for its providers, and Try again for what it couldn't. @param {any} ctx @param {{ installed: string[], failed: string[] }} got @param {boolean} imported */
function pluginsBrought(ctx, got, imported) {
  const el = h('div', {});
  const draw = (/** @type {{ installed: string[], failed: string[] }} */ g) => el.replaceChildren(
    ...(g.installed.length ? [h('p', { class: 'sub', text: `Installed what your providers use: ${g.installed.join(', ')}.` })] : []),
    ...(g.failed.length ? [h('p', { class: 'error', role: 'alert', text: g.failed.join(' ') }),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: async () => draw(await restorePlugins(ctx, imported)) }, 'Try again'))] : []));
  draw(got);
  return el;
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
 * nothing is added before that. An annai file that came with them is named, and opens on its own.
 * @param {any} ctx @param {InboxFile[]} items @param {any[]} trips @param {InboxFile[]} archives
 */
function fileInbox(ctx, items, trips, archives) {
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
  /** On the import screen, as if it had come alone; it leaves the share inbox as it opens. @param {InboxFile} a */
  async function openAnnaiFile(a) {
    if (a.key) await (await caches.open('annai-inbox')).delete(a.key);
    for (const url of urls) URL.revokeObjectURL(url);
    setPendingImport([a.file], { archive: true });
    ctx.go('#/import');
  }
  const shown = photos.slice(0, 12);
  const urls = shown.map((i) => URL.createObjectURL(i.file));
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: `Add ${what}` }),
    shown.length ? h('ul', { class: 'thumbs' }, ...shown.map((i, k) => h('li', {}, h('img', { src: urls[k], alt: i.file.name, decoding: 'async' })))) : null,
    photos.length > shown.length ? h('p', { class: 'sub', text: `and ${photos.length - shown.length} more photos` }) : null,
    others.length ? h('ul', { class: 'file-names' }, ...others.map((i) => h('li', {}, h('span', { text: `${i.file.name} · ${bytes(i.file.size)}` }), sharedText(i.file)))) : null,
    // Any site can post to the share target (spec §12.3), so the user is asked to add only their own share.
    items.some((i) => i.key) ? h('p', { class: 'sub', text: 'Add only what you just shared yourself.' }) : null,
    trips.length
      ? h('div', { class: 'acts' }, ...buttons)
      : h('p', { class: 'empty' }, `Start a trip first, then share ${n === 1 ? 'it' : 'them'} again. `, h('a', { href: '#/trips' }, 'Go to Trips')),
    status,
    ...archives.map((a) => h('div', { class: 'panel' },
      h('p', { text: `Also here: ${a.file.name}, an annai backup or trip. It isn't added with the rest; open it on its own.` }),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => openAnnaiFile(a) }, 'Open it')))));
}

/** The words of shared text, so the user sees what they would add; nothing for other files. @param {File} file */
function sharedText(file) {
  if (!file.type.startsWith('text/') || file.size > 200_000) return null;
  const el = h('blockquote', { class: 'shared-text' });
  file.text().then((t) => { el.textContent = t.length > 600 ? `${t.slice(0, 600)}…` : t; }).catch(() => {});
  return el;
}
