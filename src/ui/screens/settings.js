import { h, t, tc, field, savedField, savedCheck, numberIn } from '../dom.js';
import { readAppSettings, updateAppSettings } from '../../core/settings.js';
import { photoSettings } from '../../core/photos.js';
import { canEncode } from '../photo-codec.js';
import { eraseDatabase } from '../../core/store-idb.js';
import { SYS } from '../../core/scopes.js';
import { relTime, size, num, numField, list, sentences } from '../format.js';
import { storageStatus, requestPersist, platform, isStandalone } from '../platform.js';
import { exportPanel } from '../export-panel.js';
import { openFileButton } from '../open-file.js';
import { slotEntries } from '../slots.js';
import { warnKept } from './provider.js';
import { nameOf as updateName } from '../plugin-updates.js';

/** @param {string} title @param {...any} children */
const section = (title, ...children) => h('section', { class: 'panel', 'aria-label': title }, h('h2', { class: 'section', text: title }), ...children);

/**
 * Settings' sections in the order a user reaches for them, most often first (the user, 2026-10-18),
 * Erase last; while an update waits, Updates comes before everything.
 * @param {{ waiting: boolean }} o
 */
export function sectionOrder({ waiting }) {
  return [...(waiting ? ['updates'] : []), 'models', 'voice', 'notifications', 'backup', 'shiori', 'photos', 'tools', 'plugins', 'storage',
    ...(waiting ? [] : ['updates']), 'about', 'diagnostics', 'developer', 'experimental', 'erase'];
}

/** What waits, in a line: a new version of annai, plugin updates (named as Updates names them); null when nothing does. @param {boolean} app @param {{ id: string, name: string, url?: string }[]} plugins */
export function waitingWords(app, plugins) {
  return sentences(app ? t`A new version of annai is ready.` : '', plugins.length ? t`Plugin updates are ready: ${list(plugins.map(updateName), 'plain')}.` : '') || null;
}

/**
 * Backups' line: the kinds of place backed up to automatically, each once (a place is named by its kind, so two WebDAV places are one
 * WebDAV). @param {{ name?: string, auto: string }[]} places Backups' list
 */
export function backupLine(places) {
  const kinds = [...new Set(places.filter((p) => p.auto !== 'off').map((p) => String(p.name)))];
  return kinds.length ? t`Backing up automatically to ${list(kinds, 'plain')}.` : t`No automatic backups yet. Add a place to back up to, such as a private GitHub repository.`;
}

/** @param {string} line @param {string} href @param {string} label */
const goTo = (line, href, label) => [h('p', { class: 'sub', text: line }), h('div', { class: 'acts' }, h('a', { class: 'btn', href }, label))];

/** @param {any} ctx */
export async function renderSettings(ctx) {
  const st = await storageStatus();
  const app = await readAppSettings(ctx.ws);
  const exportSlot = h('div', {});
  const places = ctx.backups ? await ctx.backups.list() : [];
  const waits = waitingWords(Boolean(ctx.updates?.waiting), (await ctx.updates?.plugins().catch(() => [])) ?? []);
  /** @type {Record<string, () => Promise<any> | any>} */
  const sections = {
    updates: () => section(t`Updates`,
      h('p', { class: 'sub', text: waits ?? t`annai looks for new versions of itself and its plugins when it starts and when you come back to it. Check now, or see which build is running.` }),
      h('div', { class: 'acts' }, h('a', { class: waits ? /* en */ 'btn pri' : 'btn', href: '#/updates' }, t`Updates`))),
    models: () => section(t`Models`, ...goTo(t`The providers and models Shiori uses, the order each role tries them in, what she may spend a day, the cache, and when she summarizes.`, '#/models', t`Models`)),
    voice: () => section(tc('screen')`Voice`, ...goTo(t`How Shiori speaks and hears you, with a test for each.`, '#/voice', tc('screen')`Voice`)),
    notifications: () => section(t`Notifications`, ...goTo(t`Reminders while annai is closed, through the push relay, and what it learns.`, '#/notifications', t`Notifications`)),
    backup: () => section(t`Backup`,
      h('p', { class: 'sub', text: app.lastExportAt ? t`Last export ${relTime(app.lastExportAt)}.` : t`No export yet. Export regularly: annai keeps everything on this device.` }),
      h('p', { class: 'sub', text: backupLine(places) }),
      h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: () => exportSlot.replaceChildren(exportPanel(ctx, { kind: 'everything' })),
      }, t`Export everything`), h('a', { class: 'btn', href: '#/backups' }, t`Automatic backups`)),
      exportSlot,
      h('p', { class: 'sub', text: t`A trip someone sent you, or a backup to bring back:` }),
      openFileButton(ctx, t`Open an annai file`)),
    shiori: () => section(/* en */ 'Shiori', ...goTo(t`How she looks, her personality, and how often she acts on her own.`, '#/shiori', /* en */ 'Shiori')),
    photos: async () => section(t`Photos`, ...(await photoControls(ctx, app))),
    tools: () => section(t`Tools`, ...goTo(t`Switches for every tool Shiori has, web search and fetch, and the Jina key.`, '#/tools', t`Tools`)),
    plugins: async () => [section(t`Plugins`, ...goTo(t`Skills and code plugins: install, update, switch off or remove.`, '#/plugins', t`Manage plugins`)), await pluginPages(ctx)],
    storage: () => section(t`Storage`,
      h('p', { text: st.persisted ? t`Protected from automatic clearing: yes.` : t`Protected from automatic clearing: no.` }),
      st.quota ? h('p', { class: 'sub', text: t`Using ${size(st.usage)} of about ${size(st.quota)}.` }) : null,
      st.persisted ? null : h('div', { class: 'acts' }, h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          const ok = await requestPersist();
          ctx.notices.toast(ok ? t`Your data is now protected.` : t`The browser didn't agree. Installing annai to your Home Screen usually fixes this.`);
          ctx.render();
        },
      }, t`Protect my data`))),
    about: () => section(t`About`, ...goTo(t`annai ${ctx.version}: its licence, its source, the credits, and how your keys and data are kept.`, '#/about', t`About annai`)),
    diagnostics: () => section(t`Diagnostics`,
      h('p', { class: 'sub', text: t`A report of recent errors and system events, without your files or keys, to paste into a bug report.` }),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', onclick: () => copyDiagnostics(ctx) }, t`Copy diagnostics`))),
    developer: () => section(t`Developer`, ...goTo(t`Try GPS, the replay and the recap with a simulated trip.`, '#/simulate', t`Simulate a trip`)),
    experimental: () => section(t`Experimental`, ...goTo(t`Features still being tried, such as swiping between tabs. Each is off until you turn it on.`, '#/experimental', t`Experimental`)),
    erase: () => section(t`Erase`, eraseControls(ctx)),
  };
  /** @type {any[]} */
  const drawn = [];
  for (const id of sectionOrder({ waiting: waits !== null })) drawn.push(await sections[id]());
  return h('div', { class: 'screen' }, h('h1', { class: 'title', text: t`Settings` }), ...drawn);
}

/**
 * Settings → Photos (spec §4.8): Keep originals, how photos are encoded when they come in, and how
 * large the copies Shiori is sent may be. Each saves as it changes (§16.1).
 * @param {any} ctx @param {Record<string, any>} app
 */
async function photoControls(ctx, app) {
  const s = photoSettings(app);
  const webp = await canEncode('image/webp');
  const save = (/** @type {Record<string, any>} */ photos) => updateAppSettings(ctx.ws, { photos });
  const keep = savedCheck(t`Keep originals: store photos exactly as taken`, s.keepOriginals, (on) => save({ keepOriginals: on }));
  const formats = (/** @type {HTMLSelectElement} */ x) => (x.value === 'jpeg' ? ['image/jpeg'] : ['image/webp', 'image/jpeg']);
  const formatPick = (/** @type {string} */ id, /** @type {string[]} */ now) => {
    const x = h('select', { id }, h('option', { value: 'webp' }, t`WebP, or JPEG where this browser can't write WebP`), h('option', { value: 'jpeg' }, /* en */ 'JPEG'));
    x.value = now[0] === 'image/jpeg' ? 'jpeg' : 'webp';
    return x;
  };
  const number = (/** @type {string} */ id, /** @type {Record<string, string>} */ more, /** @type {number | null} */ value) =>
    h('input', { id, inputmode: 'decimal', placeholder: t`No limit`, ...more, value: numField(value) });
  const format = formatPick('photo-format', s.ingest.formats);
  const quality = number('photo-quality', { placeholder: '' }, s.ingest.quality);
  const edge = number('photo-edge', { inputmode: 'numeric' }, s.ingest.maxEdge);
  const size = number('photo-size', {}, s.ingest.maxBytes === null ? null : s.ingest.maxBytes / 1_000_000);
  const asMB = (/** @type {number | null} */ b) => (b === null ? '' : numField(Math.round(b / 10_000) / 100));
  const sentEdge = number('photo-sent-edge', { inputmode: 'numeric' }, s.request.maxEdge);
  const sentSize = h('input', { id: 'photo-sent-size', inputmode: 'decimal', placeholder: t`No limit`, value: asMB(s.request.maxBytes) });
  const sentFormat = formatPick('photo-sent-format', s.request.formats);
  const sentQuality = number('photo-sent-quality', { placeholder: '' }, s.request.quality);
  const QUALITY = t`Quality goes from ${num(0.5)} to ${num(1)}.`;
  const EDGE = t`The longest side is a whole number of pixels, at least ${num(256)}. Leave it empty for no limit.`;
  // No limit is saved as 0 (photoSettings).
  const bytesOf = (/** @type {HTMLInputElement} */ x, /** @type {string} */ words) => {
    const mb = numberIn(x, 0.1, Infinity, words);
    return mb === null ? null : Math.round(mb * 1_000_000);
  };
  // A size shown rounded and left as it was keeps its exact value (1 MiB shows as 1.05).
  const sentBytes = () => (sentSize.value.trim() === asMB(s.request.maxBytes) ? s.request.maxBytes : bytesOf(sentSize, t`The largest photo sent is at least ${num(0.1)} MB. Leave it empty for no limit.`));
  return [
    h('p', { class: 'sub', text: sentences(t`Each photo you add is stored once.`, webp ? t`This browser writes WebP.` : t`This browser can't write WebP, so photos are saved as JPEG.`, t`The originals stay in your phone's photo library.`) }),
    keep.el,
    h('div', { class: 'row' },
      savedField(t`Save photos as`, format, () => formats(format), (f) => save({ ingest: { formats: f } })),
      savedField(t`Quality (${num(0.5)} to ${num(1)})`, quality, () => numberIn(quality, 0.5, 1, QUALITY, { need: true }), (q) => save({ ingest: { quality: q } }))),
    h('div', { class: 'row' },
      savedField(t`Longest side, pixels`, edge, () => numberIn(edge, 256, 65535, EDGE, { whole: true }), (e) => save({ ingest: { maxEdge: e ?? 0 } })),
      savedField(t`Largest file, MB`, size, () => bytesOf(size, t`The largest file is at least ${num(0.1)} MB. Leave it empty for no limit.`), (b) => save({ ingest: { maxBytes: b ?? 0 } }))),
    h('h3', { text: t`Photos for Shiori` }),
    h('p', { class: 'sub', text: t`The copies she is sent, made once and kept with the conversation. A closer look always sends more detail, so small settings stay usable.` }),
    h('div', { class: 'row' },
      savedField(t`Longest side sent, pixels`, sentEdge, () => numberIn(sentEdge, 256, 65535, EDGE, { whole: true }), (e) => save({ request: { maxEdge: e ?? 0 } })),
      savedField(t`Largest photo sent, MB`, sentSize, sentBytes, (b) => save({ request: { maxBytes: b ?? 0 } }))),
    h('div', { class: 'row' },
      savedField(t`Send photos as`, sentFormat, () => formats(sentFormat), (f) => save({ request: { formats: f } })),
      savedField(t`Quality sent (${num(0.5)} to ${num(1)})`, sentQuality, () => numberIn(sentQuality, 0.5, 1, QUALITY, { need: true }), (q) => save({ request: { quality: q } }))),
  ];
}

/** Spec §17 rule 4: a redacted report the user chooses to share. @param {any} ctx */
async function copyDiagnostics(ctx) {
  const events = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ tx) => tx.listEvents(SYS, { reverse: true, limit: 200 }));
  const report = {
    app: ctx.version, platform: platform(), installed: isStandalone(), userAgent: navigator.userAgent,
    storage: await storageStatus(), at: new Date().toISOString(),
    events: events.map((/** @type {any} */ e) => ({ seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, data: e.data })),
  };
  const textOut = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(textOut);
    ctx.notices.toast(t`Diagnostics copied.`);
  } catch {
    ctx.notices.card({ title: t`Copying didn't work here. Select and copy this report:`, body: textOut.slice(0, 6000) });
  }
}

/** The word typed to erase: the same in every language, so it is never a translation's guess. */
const ERASE = /* en */ 'ERASE';

/** @param {any} ctx */
function eraseControls(ctx) {
  const input = h('input', { id: 'erase-confirm', autocomplete: 'off', autocapitalize: 'characters' });
  const keptWarn = h('p', { class: 'sub' });
  const status = h('p', { class: 'sub', role: 'status' });
  const go = h('button', {
    class: 'btn danger', type: 'button', disabled: true,
    onclick: async () => {
      go.disabled = true;
      // A live session closes and is forgotten first: its microphone with it (security review).
      ctx.agent?.hush?.('erase');
      // Shiori's turns stop; what providers keep is deleted while the keys are here (spec §4.9).
      status.textContent = t`Erasing…`;
      ctx.agent?.leaving?.();
      ctx.agent?.interrupt?.();
      ctx.agent?.stopKokoro?.();
      await ctx.llm?.forgetAll?.({ timeoutMs: 10_000 }).catch(() => {});
      ctx.store.close();
      await eraseDatabase();
      try { await caches.delete('annai-inbox'); } catch { /* no caches */ }
      // What annai keeps in the browser goes too, a sign-in waiting among it (its verifier), as on a new device; this
      // tab's scroll positions as it goes, after the shell has kept them.
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith('annai.')) localStorage.removeItem(k);
      } catch { /* storage blocked */ }
      addEventListener('pagehide', () => { try { sessionStorage.clear(); } catch { /* storage blocked */ } });
      // Not while a tap's sound unlock starts its clip: that deadlocks WebKit on Linux (welcome.spec.js).
      await ctx.voice?.settled();
      // No hashchange: nothing may render against the closed store before the reload. annai starts again at
      // its plain start, as on a new device, so the welcome shows again.
      history.replaceState(null, '', location.pathname);
      location.reload();
    },
  }, t`Erase now`);
  input.addEventListener('input', () => {
    go.disabled = input.value.trim() !== ERASE;
    warnKept(ctx, keptWarn); // what providers keep, counted as Erase is typed (G2)
  });
  return h('div', { class: 'screen' },
    h('p', { class: 'sub', text: t`Deletes every trip, file, setting and key on this device. Export a backup first.` }),
    keptWarn,
    field(t`Type ${ERASE} to confirm`, input),
    h('div', { class: 'acts' }, go),
    status);
}

/** Settings pages plugins add (spec §16.4), each with its plugin's name; nothing when there are none. @param {any} ctx */
async function pluginPages(ctx) {
  const pages = slotEntries(ctx, 'ui:settings-page');
  if (!pages.length) return null;
  const names = new Map((await ctx.plugins?.describe().catch(() => []) ?? []).map((/** @type {any} */ r) => [r.id, r.name]));
  return section(t`From plugins`, h('ul', { class: 'file-list' }, ...pages.map((e) => h('li', {},
    h('a', { href: `#/plugin-page/${encodeURIComponent(e.pluginId)}/${encodeURIComponent(e.item.id)}`, text: t`${e.item.title} (${names.get(e.pluginId) ?? e.pluginId})` })))));
}
