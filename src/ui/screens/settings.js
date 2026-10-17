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

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/** @param {any} ctx */
export async function renderSettings(ctx) {
  const st = await storageStatus();
  const app = await readAppSettings(ctx.ws);
  const exportSlot = h('div', {});
  const places = ctx.backups ? await ctx.backups.list() : [];
  const automatic = places.filter((/** @type {any} */ p) => p.auto !== 'off').map((/** @type {any} */ p) => p.name);
  return h('div', { class: 'screen' },
    h('h1', { class: 'title', text: 'Settings' }),
    section('Storage',
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
    section('Backup',
      h('p', { class: 'sub', text: app.lastExportAt ? `Last export ${relTime(app.lastExportAt)}.` : 'No export yet. Export regularly: annai keeps everything on this device.' }),
      h('p', { class: 'sub', text: automatic.length ? `Backing up automatically to ${automatic.join(', ')}.` : 'No automatic backups yet. Add a place to back up to, such as a private GitHub repository.' }),
      h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: () => exportSlot.replaceChildren(exportPanel(ctx, { kind: 'everything', title: 'everything' })),
      }, 'Export everything'), h('a', { class: 'btn', href: '#/backups' }, 'Automatic backups')),
      exportSlot),
    section('Photos', ...(await photoControls(ctx, app))),
    section('Open an annai file', openFileButton(ctx, 'Open an annai file')),
    section('Models', h('p', { class: 'sub', text: 'The endpoints and models Shiori uses, and the order each role tries them in.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/models' }, 'Models'))),
    section('Voice', h('p', { class: 'sub', text: 'How Shiori speaks and hears you, with a test for each.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/voice' }, 'Voice'))),
    section('Notifications', h('p', { class: 'sub', text: 'Reminders while annai is closed, through the push relay, and what it learns.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/notifications' }, 'Notifications'))),
    section('Shiori', h('p', { class: 'sub', text: 'Her personality, budgets and housekeeping.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/shiori' }, 'Shiori'))),
    section('Tools', h('p', { class: 'sub', text: 'Switches for every tool Shiori has, web search and fetch, and the Jina key.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/tools' }, 'Tools'))),
    section('Plugins', h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/plugins' }, 'Manage plugins'))),
    section('App',
      h('p', { text: `annai ${ctx.version}` }),
      ctx.update.ready
        ? h('div', { class: 'acts' }, h('span', { text: 'An update is ready.' }), h('button', { class: 'btn pri', type: 'button', onclick: () => ctx.update.apply() }, 'Restart annai'))
        : h('p', { class: 'sub', text: 'No update waiting.' })),
    section('Developer',
      h('p', { class: 'sub', text: 'Try live mode, the replay and the recap with a simulated trip.' }),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/simulate' }, 'Simulate a trip'))),
    section('Diagnostics',
      h('p', { class: 'sub', text: 'A report of recent errors and system events, without your files or keys, to paste into a bug report.' }),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => copyDiagnostics(ctx) }, 'Copy diagnostics'))),
    section('Erase', eraseControls(ctx)));
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
      // No hashchange: nothing may render against the closed store before the reload.
      history.replaceState(null, '', '#/trips');
      location.reload();
    },
  }, 'Erase now');
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'ERASE'; });
  return h('div', { class: 'screen' },
    h('p', { class: 'sub', text: 'Deletes every trip, file, setting and key on this device. Export a backup first.' }),
    field('Type ERASE to confirm', input),
    h('div', { class: 'acts' }, go));
}
