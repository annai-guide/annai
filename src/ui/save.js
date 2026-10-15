/**
 * Hands a file to the user: the share sheet where it can take files (iOS: "Save to Files"),
 * otherwise a download. Call it from a tap, because share sheets need a fresh user action.
 * @param {Blob} blob @param {string} filename
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  let forceDownload = false;
  try { forceDownload = localStorage.getItem('annai.forceDownload') === '1'; } catch { /* storage blocked */ }
  if (!forceDownload && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
