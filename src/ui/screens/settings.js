import { h, field } from '../dom.js';
import { readAppSettings } from '../../core/settings.js';
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
      h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: () => exportSlot.replaceChildren(exportPanel(ctx, { kind: 'everything', title: 'everything' })),
      }, 'Export everything')),
      exportSlot),
    section('Open an annai file', openFileButton(ctx, 'Open an annai file')),
    section('Plugins', h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/plugins' }, 'Manage plugins'))),
    section('App',
      h('p', { text: `annai ${ctx.version}` }),
      ctx.update.ready
        ? h('div', { class: 'acts' }, h('span', { text: 'An update is ready.' }), h('button', { class: 'btn pri', type: 'button', onclick: () => ctx.update.apply() }, 'Restart annai'))
        : h('p', { class: 'sub', text: 'No update waiting.' })),
    section('Diagnostics',
      h('p', { class: 'sub', text: 'A report of recent errors and system events, without your files or keys, to paste into a bug report.' }),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => copyDiagnostics(ctx) }, 'Copy diagnostics'))),
    section('Erase', eraseControls(ctx)));
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
      location.hash = '#/trips';
      location.reload();
    },
  }, 'Erase now');
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'ERASE'; });
  return h('div', { class: 'screen' },
    h('p', { class: 'sub', text: 'Deletes every trip, file, setting and key on this device. Export a backup first.' }),
    field('Type ERASE to confirm', input),
    h('div', { class: 'acts' }, go));
}
