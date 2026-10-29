/**
 * A file's first page for the screens (the bookings design, goal 12 and "PDF preview without a new dependency in annai's own code"):
 * a photo is itself; a PDF is the browser's own drawing where its <img> draws PDFs (Safari), else the PDF pages plugin's page 1 when
 * it runs, else nothing, and the caller shows the file card.
 */
import { runningPdfPages } from '../core/pdf-pages.js';

export const PREVIEW_EDGE = 1200; // px, the plugin's first page for a preview

/** A one-page PDF of a few hundred bytes, made here, that a browser whose <img> draws PDFs decodes. */
const TINY_PDF = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 8 8] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n182\n%%EOF\n';

/** @type {Promise<boolean> | null} */
let draws = null;

/**
 * Whether this browser's <img> draws a PDF's first page (Safari): told once, by drawing a tiny PDF made here, never by the browser's
 * name. @returns {Promise<boolean>}
 */
export function imgDrawsPdf() {
  draws ??= (async () => {
    const url = URL.createObjectURL(new Blob([TINY_PDF], { type: 'application/pdf' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img.naturalWidth > 0;
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  return draws;
}

/**
 * An object URL of the file's first page as a picture, or null when nothing here can draw it (the caller shows the file card). The
 * caller revokes the URL when it stops showing it. It never throws.
 * @param {Blob} file its type says what it is @param {{ registry?: import('../core/registry.js').Registry | null, signal?: AbortSignal }} [o]
 * @returns {Promise<string | null>}
 */
export async function previewOf(file, o = {}) {
  try {
    if (file.type.startsWith('image/')) {
      // A photo type this browser decodes (a HEIC isn't, outside Safari).
      const bitmap = await createImageBitmap(file);
      bitmap.close();
      return URL.createObjectURL(file);
    }
    if (file.type !== 'application/pdf') return null;
    if (await imgDrawsPdf()) return URL.createObjectURL(file);
    const plugin = runningPdfPages(o.registry);
    if (!plugin) return null;
    const [page] = (await plugin.pages(new Uint8Array(await file.arrayBuffer()), { max: 1, edge: PREVIEW_EDGE, signal: o.signal })).pages;
    return page ? URL.createObjectURL(new Blob([/** @type {BlobPart} */ (page.bytes)], { type: page.type })) : null;
  } catch {
    return null;
  }
}
