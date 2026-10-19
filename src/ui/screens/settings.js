import { h, field, checkbox } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { photoSettings } from '../../core/photos.js';
import { canEncode } from '../photo-codec.js';
import { eraseDatabase } from '../../core/store-idb.js';
import { SYS } from '../../core/scopes.js';
import { relTime, bytes } from '../format.js';
import { storageStatus, requestPersist, platform, isStandalone } from '../platform.js';
import { exportPanel } from '../export-panel.js';
import { openFileButton } from '../open-file.js';
import { slotEntries } from '../slots.js';

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/**
 * Settings' sections in the order a user reaches for them, most often first (the user, 2026-10-18),
 * Erase last; while an update waits, it comes before everything.
 * @param {{ updateReady: boolean }} o
 */
export function sectionOrder({ updateReady }) {
  return [...(updateReady ? ['update'] : []), 'models', 'voice', 'notifications', 'backup', 'shiori', 'photos', 'tools', 'plugins', 'storage',
    'about', 'diagnostics', 'developer', 'experimental', 'erase'];
}

/** @param {string} line @param {string} href @param {string} label */
const goTo = (line, href, label) => [h('p', { class: 'sub', text: line }), h('div', { class: 'acts' }, h('a', { class: 'btn', href }, label))];

/** @param {any} ctx */
export async function renderSettings(ctx) {
  const st = await storageStatus();
  const app = await readAppSettings(ctx.ws);
  const exportSlot = h('div', {});
  const places = ctx.backups ? await ctx.backups.list() : [];
  const automatic = places.filter((/** @type {any} */ p) => p.auto !== 'off').map((/** @type {any} */ p) => p.name);
  /** @type {Record<string, () => Promise<any> | any>} */
  const sections = {
    update: () => section('Update',
      h('p', { class: 'sub', text: `A new version of annai is ready. It is used the next time annai starts. This is annai ${ctx.version}.` }),
      h('div', { class: 'acts' }, h('button', { class: 'btn pri', type: 'button', onclick: () => ctx.update.apply() }, 'Restart annai'))),
    models: () => section('Models', ...goTo('The endpoints and models Shiori uses, and the order each role tries them in.', '#/models', 'Models')),
    voice: () => section('Voice', ...goTo('How Shiori speaks and hears you, with a test for each.', '#/voice', 'Voice')),
    notifications: () => section('Notifications', ...goTo('Reminders while annai is closed, through the push relay, and what it learns.', '#/notifications', 'Notifications')),
    backup: () => section('Backup',
      h('p', { class: 'sub', text: app.lastExportAt ? `Last export ${relTime(app.lastExportAt)}.` : 'No export yet. Export regularly: annai keeps everything on this device.' }),
      h('p', { class: 'sub', text: automatic.length ? `Backing up automatically to ${automatic.join(', ')}.` : 'No automatic backups yet. Add a place to back up to, such as a private GitHub repository.' }),
      h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: () => exportSlot.replaceChildren(exportPanel(ctx, { kind: 'everything', title: 'everything' })),
      }, 'Export everything'), h('a', { class: 'btn', href: '#/backups' }, 'Automatic backups')),
      exportSlot,
      h('p', { class: 'sub', text: 'A trip someone sent you, or a backup to bring back:' }),
      openFileButton(ctx, 'Open an annai file')),
    shiori: () => section('Shiori', ...goTo('Her personality, budgets and housekeeping.', '#/shiori', 'Shiori')),
    photos: async () => section('Photos', ...(await photoControls(ctx, app))),
    tools: () => section('Tools', ...goTo('Switches for every tool Shiori has, web search and fetch, and the Jina key.', '#/tools', 'Tools')),
    plugins: async () => [section('Plugins', ...goTo('Skills and code plugins: install, update, switch off or remove.', '#/plugins', 'Manage plugins')), await pluginPages(ctx)],
    storage: () => section('Storage',
      h('p', { text: st.persisted ? 'Protected from automatic clearing: yes.' : 'Protected from automatic clearing: no.' }),
      st.quota ? h('p', { class: 'sub', text: `Using ${bytes(st.usage)} of about ${bytes(st.quota)}.` }) : null,
      st.persisted ? null : h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          const ok = await requestPersist();
          ctx.notices.toast(ok ? 'Your data is now protected.' : "The browser didn't agree. Installing annai to your Home Screen usually fixes this.");
          ctx.render();
        },
      }, 'Protect my data'))),
    about: () => section('About', ...goTo(`annai ${ctx.version}: its licence, its source, the credits, and how your keys and data are kept.`, '#/about', 'About annai')),
    diagnostics: () => section('Diagnostics',
      h('p', { class: 'sub', text: 'A report of recent errors and system events, without your files or keys, to paste into a bug report.' }),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => copyDiagnostics(ctx) }, 'Copy diagnostics'))),
    developer: () => section('Developer', ...goTo('Try live mode, the replay and the recap with a simulated trip.', '#/simulate', 'Simulate a trip')),
    experimental: () => section('Experimental', ...goTo('Features still being tried, such as swiping between tabs. Each is off until you turn it on.', '#/experimental', 'Experimental')),
    erase: () => section('Erase', eraseControls(ctx)),
  };
  /** @type {any[]} */
  const drawn = [];
  for (const id of sectionOrder({ updateReady: Boolean(ctx.update?.ready) })) drawn.push(await sections[id]());
  return h('div', { class: 'screen' }, h('h1', { class: 'title', text: 'Settings' }), ...drawn);
}

/**
 * Settings → Photos (spec §4.8): Keep originals, how photos are encoded when they come in, and how
 * large the copies Shiori is sent may be.
 * @param {any} ctx @param {Record<string, any>} app
 */
async function photoControls(ctx, app) {
  const s = photoSettings(app);
  const webp = await canEncode('image/webp');
  const keep = checkbox('Keep originals: store photos exactly as taken', s.keepOriginals);
  const format = h('select', { id: 'photo-format' },
    h('option', { value: 'webp' }, "WebP, or JPEG where this browser can't write WebP"),
    h('option', { value: 'jpeg' }, 'JPEG'));
  format.value = s.ingest.formats[0] === 'image/jpeg' ? 'jpeg' : 'webp';
  const quality = h('input', { id: 'photo-quality', type: 'number', min: '0.5', max: '1', step: '0.05', value: String(s.ingest.quality) });
  const edge = h('input', { id: 'photo-edge', type: 'number', min: '256', step: '1', placeholder: 'No limit', value: s.ingest.maxEdge === null ? '' : String(s.ingest.maxEdge) });
  const size = h('input', { id: 'photo-size', type: 'number', min: '0.1', step: '0.1', placeholder: 'No limit', value: s.ingest.maxBytes === null ? '' : String(s.ingest.maxBytes / 1_000_000) });
  const asMB = (/** @type {number | null} */ b) => (b === null ? '' : String(Math.round(b / 10_000) / 100));
  const sentEdge = h('input', { id: 'photo-sent-edge', type: 'number', min: '256', step: '1', placeholder: 'No limit', value: s.request.maxEdge === null ? '' : String(s.request.maxEdge) });
  const sentSize = h('input', { id: 'photo-sent-size', type: 'number', min: '0.1', step: '0.01', placeholder: 'No limit', value: asMB(s.request.maxBytes) });
  const sentFormat = h('select', { id: 'photo-sent-format' },
    h('option', { value: 'webp' }, "WebP, or JPEG where this browser can't write WebP"),
    h('option', { value: 'jpeg' }, 'JPEG'));
  sentFormat.value = s.request.formats[0] === 'image/jpeg' ? 'jpeg' : 'webp';
  const sentQuality = h('input', { id: 'photo-sent-quality', type: 'number', min: '0.5', max: '1', step: '0.05', value: String(s.request.quality) });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      const q = Number(quality.value);
      const e = edge.value.trim() === '' ? null : Number(edge.value);
      const mb = size.value.trim() === '' ? null : Number(size.value);
      if (!(q >= 0.5 && q <= 1) || (e !== null && !(Number.isInteger(e) && e >= 256)) || (mb !== null && !(mb >= 0.1))) {
        error.textContent = 'Quality goes from 0.5 to 1, the longest side is at least 256 pixels, and the largest file at least 0.1 MB. Leave a limit empty for none.';
        error.hidden = false;
        return;
      }
      const sq = Number(sentQuality.value);
      const se = sentEdge.value.trim() === '' ? null : Number(sentEdge.value);
      const smb = sentSize.value.trim() === '' ? null : Number(sentSize.value);
      if (!(sq >= 0.5 && sq <= 1) || (se !== null && !(Number.isInteger(se) && se >= 256)) || (smb !== null && !(smb >= 0.1))) {
        error.textContent = 'For photos sent to Shiori, quality goes from 0.5 to 1, the longest side is at least 256 pixels, and the largest photo at least 0.1 MB. Leave a limit empty for none.';
        error.hidden = false;
        return;
      }
      error.hidden = true;
      // A size shown rounded and left as it was keeps its exact value (1 MiB shows as 1.05).
      const sentBytes = sentSize.value.trim() === asMB(s.request.maxBytes) ? s.request.maxBytes : smb === null ? null : Math.round(smb * 1_000_000);
      await updateAppSettings(ctx.ws, {
        photos: {
          keepOriginals: keep.input.checked,
          ingest: { formats: format.value === 'jpeg' ? ['image/jpeg'] : ['image/webp', 'image/jpeg'], quality: q, maxEdge: e, maxBytes: mb === null ? null : Math.round(mb * 1_000_000) },
          request: { formats: sentFormat.value === 'jpeg' ? ['image/jpeg'] : ['image/webp', 'image/jpeg'], quality: sq, maxEdge: se, maxBytes: sentBytes },
        },
      });
      ctx.notices.toast('Photo settings saved');
    },
  }, 'Save photo settings');
  return [
    h('p', { class: 'sub', text: `Each photo you add is stored once. ${webp ? 'This browser writes WebP.' : "This browser can't write WebP, so photos are saved as JPEG."} The originals stay in your phone's photo library.` }),
    keep.el,
    h('div', { class: 'row' }, field('Save photos as', format), field('Quality (0.5 to 1)', quality)),
    h('div', { class: 'row' }, field('Longest side, pixels', edge), field('Largest file, MB', size)),
    h('h3', { text: 'Photos for Shiori' }),
    h('p', { class: 'sub', text: 'The copies she is sent, made once and kept with the conversation. A closer look always sends more detail, so small settings stay usable.' }),
    h('div', { class: 'row' }, field('Longest side sent, pixels', sentEdge), field('Largest photo sent, MB', sentSize)),
    h('div', { class: 'row' }, field('Send photos as', sentFormat), field('Quality sent (0.5 to 1)', sentQuality)),
    error,
    h('div', { class: 'acts' }, save),
  ];
}

/** Spec §17 rule 4: a redacted report the user chooses to share. @param {any} ctx */
async function copyDiagnostics(ctx) {
  const events = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS, { reverse: true, limit: 200 }));
  const report = {
    app: ctx.version, platform: platform(), installed: isStandalone(), userAgent: navigator.userAgent,
    storage: await storageStatus(), at: new Date().toISOString(),
    events: events.map((/** @type {any} */ e) => ({ seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, data: e.data })),
  };
  const textOut = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(textOut);
    ctx.notices.toast('Diagnostics copied.');
  } catch {
    ctx.notices.card({ title: "Copying didn't work here. Select and copy this report:", body: textOut.slice(0, 6000) });
  }
}

/** @param {any} ctx */
function eraseControls(ctx) {
  const input = h('input', { id: 'erase-confirm', autocomplete: 'off', autocapitalize: 'characters' });
  const go = h('button', {
    class: 'btn danger', type: 'button', disabled: true,
    onclick: async () => {
      go.disabled = true;
      ctx.store.close();
      await eraseDatabase();
      try { await caches.delete('annai-inbox'); } catch { /* no caches */ }
      // No hashchange: nothing may render against the closed store before the reload. annai starts again at
      // its plain start, as on a new device, so the welcome shows again.
      history.replaceState(null, '', location.pathname);
      location.reload();
    },
  }, 'Erase now');
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'ERASE'; });
  return h('div', { class: 'screen' },
    h('p', { class: 'sub', text: 'Deletes every trip, file, setting and key on this device. Export a backup first.' }),
    field('Type ERASE to confirm', input),
    h('div', { class: 'acts' }, go));
}

/** Settings pages plugins add (spec §16.4), each with its plugin's name; nothing when there are none. @param {any} ctx */
async function pluginPages(ctx) {
  const pages = slotEntries(ctx, 'ui:settings-page');
  if (!pages.length) return null;
  const names = new Map((await ctx.plugins?.describe().catch(() => []) ?? []).map((/** @type {any} */ r) => [r.id, r.name]));
  return section('From plugins', h('ul', { class: 'file-list' }, ...pages.map((e) => h('li', {},
    h('a', { href: `#/plugin-page/${encodeURIComponent(e.pluginId)}/${encodeURIComponent(e.item.id)}`, text: `${e.item.title} (${names.get(e.pluginId) ?? e.pluginId})` })))));
}
