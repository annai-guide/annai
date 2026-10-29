/**
 * A file's first page for the screens (the bookings design, goal 12 and "PDF preview without a new dependency in annai's own code"):
 * a photo is itself; a PDF is the browser's own drawing where its <img> draws PDFs (Safari), else the PDF pages plugin's page 1 when
 * it runs, else nothing, and the caller shows the file card.
 */
import { runningPdfPages } from '../core/pdf-pages.js';
import { blobBytes } from '../core/reach.js';
import { h, plural } from './dom.js';

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
 * Whether an <img> takes this URL: for a photo, its type read from its first bytes (load), never the whole photo decoded; for a PDF,
 * its first page drawn (decode), so a locked or broken one is no. @param {string} url @param {boolean} draw
 * @returns {Promise<boolean>}
 */
function takes(url, draw) {
  const img = new Image();
  return new Promise((resolve) => {
    img.onerror = () => resolve(false);
    img.onload = () => resolve(img.naturalWidth > 0);
    img.src = url;
    if (draw) img.decode().then(() => resolve(img.naturalWidth > 0), () => resolve(false));
  });
}

/**
 * An object URL of the file's first page as a picture, or null when nothing here can draw it (the caller shows the file card). The
 * caller revokes the URL when it stops showing it. It never throws.
 * @param {Blob} file its type says what it is @param {{ registry?: import('../core/registry.js').Registry | null, signal?: AbortSignal }} [o]
 * @returns {Promise<string | null>}
 */
export async function previewOf(file, o = {}) {
  /** @type {string | null} */
  let url = null;
  try {
    if (file.type.startsWith('image/') || (file.type === 'application/pdf' && (await imgDrawsPdf()))) {
      // A photo type this browser shows (a HEIC isn't, outside Safari); a PDF where its <img> draws this one.
      url = URL.createObjectURL(file);
      if (await takes(url, !file.type.startsWith('image/'))) return url;
      URL.revokeObjectURL(url);
      url = null;
      if (file.type !== 'application/pdf') return null;
    }
    if (file.type !== 'application/pdf') return null;
    const plugin = runningPdfPages(o.registry);
    if (!plugin) return null;
    const [page] = (await plugin.pages(new Uint8Array(await file.arrayBuffer()), { max: 1, edge: PREVIEW_EDGE, signal: o.signal })).pages;
    return page ? URL.createObjectURL(new Blob([/** @type {BlobPart} */ (page.bytes)], { type: page.type })) : null;
  } catch {
    if (url) URL.revokeObjectURL(url);
    return null;
  }
}

/** How far into a PDF its page count is looked for: a page tree is near the start, and a big file is never read whole. */
const PAGES_WITHIN = 2 * 1024 * 1024;

/**
 * A PDF's page count, from its own page tree: the largest /Count of a /Type /Pages dictionary in its first 2 MiB, read as Latin-1. Null
 * when there is none there (a scan whose objects are compressed), or the bytes aren't a PDF. @param {Uint8Array} bytes
 * @returns {number | null}
 */
export function pdfPages(bytes) {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, PAGES_WITHIN));
  if (!text.startsWith('%PDF-')) return null;
  let most = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages(?![A-Za-z])/g)) {
    // The dictionary it is in: from the last "<<" before it to the first ">>" after it.
    const from = text.lastIndexOf('<<', m.index);
    const to = text.indexOf('>>', m.index);
    const count = /\/Count\s+(\d+)/.exec(text.slice(from < 0 ? m.index : from, to < 0 ? undefined : to));
    if (count) most = Math.max(most, Number(count[1]));
  }
  return most > 0 ? most : null;
}

const SVG = 'http://www.w3.org/2000/svg';
/** A file's icon by what it is: a page with a fold, with lines for a text, a band for a PDF, a ticket for a pass. @param {string} type */
function fileIcon(type) {
  const kind = type === 'application/pdf' ? 'pdf' : type === 'application/vnd.apple.pkpass' ? 'pass' : type.startsWith('text/') || type === 'message/rfc822' ? 'text' : 'other';
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '40', height: '40', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `file-icon ${kind}` })) svg.setAttribute(k, v);
  const page = [/* en */ 'M6 3h8l4 4v14H6z', /* en */ 'M14 3v4h4'];
  const d = {
    pdf: [...page, /* en */ 'M8 13h8v4H8z'],
    text: [...page, /* en */ 'M9 11h6M9 14h6M9 17h4'],
    pass: [/* en */ 'M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z', /* en */ 'M9 7v10'],
    other: page,
  }[kind];
  for (const part of d) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', part);
    svg.append(path);
  }
  return svg;
}

/**
 * A file shown as a card where nothing draws it: its icon, its name, and how many pages when that is known.
 * @param {{ name: string, type: string, pages?: number | null }} o @returns {HTMLElement}
 */
export function fileCard({ name, type, pages }) {
  return h('div', { class: 'file-card' }, fileIcon(type),
    h('span', { class: 'file-card-words' },
      h('span', { class: 'name', dir: 'auto', text: name }),
      pages ? h('span', { class: 'sub', text: plural(pages, '# page', '# pages') }) : null));
}

/**
 * The first page a model was shown of this PDF, kept with its conversation as a `reading` (save data on the go: never drawn again for a
 * preview); null when there is none. @param {any} ctx @param {string} scope @param {string} hash the file's
 * @returns {Promise<Blob | null>}
 */
async function keptFirstPage(ctx, scope, hash) {
  const entries = await ctx.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['reading'], reverse: true }));
  for (const e of entries) {
    if (e.data?.hash !== hash || e.data?.how !== 'pages' || !Array.isArray(e.data.images)) continue;
    const first = e.data.images.find((/** @type {any} */ i) => (i.page ?? 1) === 1);
    const bytes = first ? await blobBytes(ctx.store, scope, first.hash, { named: e, via: e.type }) : null;
    if (bytes) return new Blob([/** @type {BlobPart} */ (bytes)], { type: String(first.mediaType) });
  }
  return null;
}

/**
 * What a screen shows for a stored file: its first page as a picture where something here draws it (previewOf, or a page kept from a
 * reading), else its card, with the page count of a PDF; null when there is no such file. The picture's URL goes once it has loaded.
 * @param {any} ctx @param {string} scope @param {string} path @param {{ name?: string }} [o] name: what the card calls it (a short name)
 * @returns {Promise<HTMLElement | null>}
 */
export async function filePreview(ctx, scope, path, o = {}) {
  const got = await ctx.ws.read(scope, path).catch(() => undefined);
  if (!got) return null;
  const { entry, bytes } = got;
  const name = o.name ?? path.split('/').pop() ?? path;
  const card = () => fileCard({ name, type: entry.type, pages: entry.type === 'application/pdf' ? pdfPages(bytes) : null });
  const file = new Blob([/** @type {BlobPart} */ (bytes)], { type: entry.type });
  let url = null;
  if (entry.type === 'application/pdf' && !(await imgDrawsPdf())) {
    const kept = await keptFirstPage(ctx, scope, entry.hash).catch(() => null);
    if (kept) url = URL.createObjectURL(kept);
  }
  url ??= await previewOf(file, { registry: ctx.registry });
  if (!url) return card();
  const img = h('img', { class: 'file-preview', src: url, alt: name });
  const done = () => URL.revokeObjectURL(/** @type {string} */ (url));
  img.addEventListener('load', done, { once: true });
  // One the browser can't draw after all: its card instead.
  img.addEventListener('error', () => { done(); img.replaceWith(card()); }, { once: true });
  return img;
}
