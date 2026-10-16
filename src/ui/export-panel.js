import { h, field, checkbox, radios } from './dom.js';
import { exportArchive, PRESETS } from '../core/archive.js';
import { updateAppSettings, readAppSettings } from '../core/settings.js';
import { photoSettings, MAX_CANVAS_PIXELS } from '../core/photos.js';
import { codec } from './photo-codec.js';
import { bytes } from './format.js';
import { saveFile } from './save.js';

let n = 0;
/**
 * Export choices (spec §12.2). Building and saving are two taps, because the
 * share sheet needs a fresh tap and encrypting can take a few seconds.
 * @param {any} ctx
 * @param {{ kind: 'trip'|'everything', scopes?: string[], title: string }} what
 */
export function exportPanel(ctx, what) {
  const k = n++;
  const isTrip = what.kind === 'trip';
  const history = checkbox('History (every version and the log)', true);
  const memory = checkbox('Memory', true);
  const photos = checkbox('Photos', true);
  const keys = isTrip ? null : checkbox('Include API keys (needs a passphrase)', false);
  const places = checkbox('Include where photos were taken', true);
  places.el.hidden = true; // a Share option (§12.2)
  let mode = 'backup';
  const preset = isTrip
    ? radios('What to include', [['backup', 'Backup: everything'], ['share', 'Share: plan, bookings, files and notes']], 'backup', (v) => {
      mode = v;
      const p = PRESETS[/** @type {'backup'|'share'} */ (v)];
      history.input.checked = p.history;
      memory.input.checked = p.memory;
      photos.input.checked = p.photos;
      places.el.hidden = v !== 'share';
    })
    : null;
  const pass1 = h('input', { id: `export-pass-${k}`, type: 'password', autocomplete: 'new-password' });
  const pass2 = h('input', { id: `export-pass2-${k}`, type: 'password', autocomplete: 'new-password' });
  const status = h('p', { class: 'sub', role: 'status' });
  /** @type {{ blob: Blob, filename: string } | null} */
  let built = null;
  const saveBtn = h('button', {
    class: 'btn pri', type: 'button', hidden: true,
    onclick: async () => {
      if (!built) return;
      const how = await saveFile(built.blob, built.filename);
      if (how === 'cancelled') return;
      await updateAppSettings(ctx.ws, { lastExportAt: Date.now() });
      status.textContent = how === 'shared' ? 'Shared.' : 'Saved to your downloads.';
    },
  }, 'Save file');
  const build = h('button', {
    class: 'btn pri', type: 'button',
    onclick: async () => {
      if (pass1.value !== pass2.value) { status.textContent = "The passphrases don't match."; return; }
      if (keys?.input.checked && !pass1.value) { status.textContent = 'API keys can only be exported with a passphrase.'; return; }
      build.disabled = true;
      saveBtn.hidden = true;
      status.textContent = pass1.value ? 'Building and encrypting. This takes a few seconds…' : 'Building…';
      try {
        const share = mode === 'share' ? { places: places.input.checked, convert: await photoConverter(ctx) } : undefined;
        const result = await exportArchive(ctx.store, {
          kind: what.kind, scopes: what.scopes,
          include: { history: history.input.checked, memory: memory.input.checked, photos: photos.input.checked },
          secrets: keys?.input.checked ?? false, passphrase: pass1.value || undefined, app: ctx.version, share,
        });
        built = result;
        const left = result.skipped.length
          ? ` Left out, because this browser can't remove where they were taken: ${result.skipped.join(', ')}.`
          : '';
        status.textContent = `Ready: ${result.filename} (${bytes(result.blob.size)}). Tap Save file.${left}`;
        saveBtn.hidden = false;
        saveBtn.focus();
      } catch (e) {
        status.textContent = String(/** @type {any} */ (e)?.message ?? e);
      } finally {
        build.disabled = false;
      }
    },
  }, 'Build file');
  return h('section', { class: 'panel', 'aria-label': 'Export' },
    h('h2', { class: 'section', text: isTrip ? `Export ${what.title}` : 'Export everything' }),
    preset,
    h('div', { class: 'checks' }, history.el, memory.el, photos.el, places.el, keys?.el ?? null),
    h('div', { class: 'row' }, field('Passphrase (optional)', pass1), field('Repeat passphrase', pass2)),
    h('p', { class: 'sub', text: 'With a passphrase, the file is encrypted. Without it, anyone with the file can read it.' }),
    h('div', { class: 'acts' }, build, saveBtn),
    status);
}

/** Encodes a photo for a Share with the ingest settings (§12.2). @param {any} ctx */
async function photoConverter(ctx) {
  const s = photoSettings(await readAppSettings(ctx.ws)).ingest;
  return (/** @type {{ type: string }} */ file, /** @type {Uint8Array} */ data) =>
    codec.encode(new Blob([/** @type {BlobPart} */ (data)], { type: file.type }), { ...s, maxPixels: MAX_CANVAS_PIXELS });
}
