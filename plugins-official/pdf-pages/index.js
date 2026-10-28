/**
 * PDF pages (the bookings design, goal 12): a PDF's pages as pictures, for a model that sees photos but reads no PDFs, and a PDF's
 * first page for its preview in any browser. The drawing is Mozilla's PDF.js (vendor/pdfjs, its legacy build; docs/deps.md), loaded
 * on the first PDF, never at activate. Pages are drawn on the device; nothing leaves it.
 * @param {any} annai
 */
export function activate(annai) {
  return annai.register('pdf-pages', { id: 'pdfjs', pages });
}

/** A file of the vendored PDF.js, by its path here. @param {string} path */
const here = (path) => new URL(`vendor/pdfjs/${path}`, import.meta.url).href;

/** PDF.js, imported once. @type {Promise<any> | null} */
let lib = null;

/**
 * PDF.js, imported on the first call. An engine without Promise.withResolvers (Safari before 17.4) gets it shimmed, and PDF.js's
 * worker is then run on the page, where the shim is, rather than in a worker of its own, where it isn't.
 */
function pdfjs() {
  lib ??= (async () => {
    if (!(/** @type {any} */ (Promise).withResolvers)) {
      /** @type {any} */ (Promise).withResolvers = function withResolvers() {
        /** @type {any} */ let resolve, reject;
        const promise = new this((/** @type {any} */ a, /** @type {any} */ b) => { resolve = a; reject = b; });
        return { promise, resolve, reject };
      };
      /** @type {any} */ (globalThis).pdfjsWorker ??= await import(here('build/pdf.worker.min.mjs'));
    }
    const m = await import(here('build/pdf.min.mjs'));
    m.GlobalWorkerOptions.workerSrc = here('build/pdf.worker.min.mjs');
    return m;
  })().catch((e) => {
    lib = null;
    console.warn(/* en */ 'PDF.js could not be loaded', e);
    /* en */
    throw new Error("This browser can't run PDF.js, so a PDF's pages can't be drawn here.");
  });
  return lib;
}

/** Whether a drawn page is white all over: no pixel darker than the faintest grey a scan's paper shows. @param {CanvasRenderingContext2D} g @param {number} w @param {number} h */
function blankCanvas(g, w, h) {
  const { data } = g.getImageData(0, 0, w, h);
  for (let i = 0; i < data.length; i += 4) if (data[i] < 248 || data[i + 1] < 248 || data[i + 2] < 248) return false;
  return true;
}

/** The longest side a page is drawn at, at most, as a multiple of its own size. */
const MOST_SCALE = 4;

/**
 * Draws a PDF's pages as JPEG pictures, white behind each page. An Error in plain words is the answer for a PDF that can't be drawn
 * (locked, broken); the bytes given are left whole (PDF.js is handed a copy, as it transfers what it gets to its worker).
 * @param {Uint8Array} bytes @param {{ from?: number, max: number, edge: number, signal?: AbortSignal }} o
 *   from: the first page, 1-based; max: how many at most; edge: each picture's longest side, in px
 * @returns {Promise<{ count: number, pages: { type: string, bytes: Uint8Array, width: number, height: number }[], blank?: number[] }>} blank: the pages
 *   drawn with nothing on them, left out of pages (they count toward max)
 */
export async function pages(bytes, { from = 1, max, edge, signal }) {
  /* en */
  const stopped = () => new Error('Drawing its pages was stopped.');
  if (signal?.aborted) throw stopped();
  const m = await pdfjs();
  if (signal?.aborted) throw stopped();
  const task = m.getDocument({
    data: bytes.slice(), cMapUrl: here('cmaps/'), cMapPacked: true, standardFontDataUrl: here('standard_fonts/'), wasmUrl: here('wasm/'),
    useWasm: false, useWorkerFetch: false, enableXfa: false, verbosity: 0,
    // The browser's ImageDecoder drew a scanned page's JPEG blank in WebKit (PDF.js 6.4.299, measured): PDF.js's own decoder draws it.
    isImageDecoderSupported: false,
  });
  const stop = () => { task.destroy(); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const doc = await task.promise;
    const count = doc.numPages;
    const out = [];
    /** @type {number[]} */
    const blank = [];
    for (let n = Math.max(1, from); n <= Math.min(count, from + max - 1); n++) {
      if (signal?.aborted) throw stopped();
      const page = await doc.getPage(n);
      const own = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(edge / Math.max(own.width, own.height), MOST_SCALE) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
      g.fillStyle = '#fff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: g, canvas, viewport }).promise;
      page.cleanup();
      // A page with nothing drawn on it (a booking's empty last page) isn't sent, only named: it would cost a picture every turn.
      if (blankCanvas(g, canvas.width, canvas.height)) {
        blank.push(n);
        canvas.width = canvas.height = 0;
        continue;
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      /* en */
      if (!blob) throw new Error(`Page ${n} was drawn, but this browser couldn't make a picture of it.`);
      out.push({ type: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height });
      canvas.width = canvas.height = 0; // let the browser have its memory back now (Safari keeps a canvas's pixels until collected)
    }
    return { count, pages: out, ...(blank.length ? { blank } : {}) };
  } catch (e) {
    // PDF.js's errors are answers about this PDF, never a crash of the plugin: a PDF that trips PDF.js up must not switch it off.
    if (signal?.aborted) throw stopped();
    const name = /** @type {any} */ (e)?.name;
    /* en */
    if (name === 'PasswordException') throw new Error("This PDF is locked with a password, so its pages can't be drawn.");
    /* en */
    if (name === 'InvalidPDFException') throw new Error("This file isn't a PDF that can be read.");
    /* en */
    throw new Error(`Its pages couldn't be drawn: ${/** @type {any} */ (e)?.message ?? e}`);
  } finally {
    signal?.removeEventListener('abort', stop);
    // The loading task owns the document (PDF.js 6 has no PDFDocumentProxy.destroy): this ends both, and the worker it ran on.
    await task.destroy().catch(() => {});
  }
}
