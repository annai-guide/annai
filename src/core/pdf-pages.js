/**
 * The pdf-pages kind (bookings design, goal 12): a plugin that draws a PDF's pages as pictures, for a model that sees photos
 * but reads no PDFs, and for a PDF's preview. annai's own code has no PDF library; the official PDF pages plugin brings one.
 */
import { PluginError, isPluginBug } from './registry.js';

export const MAX_PAGES = 10; // pages drawn for a model, at most
export const PAGE_EDGE = 1600; // px, a page picture's longest side for a model

/** @typedef {{ type: string, bytes: Uint8Array, width: number, height: number }} PageImage */
/** @typedef {{ count: number, pages: PageImage[] }} Drawn  count: the PDF's pages; pages: those drawn */
/** @typedef {{ pluginId: string, pages: (bytes: Uint8Array, o: { from?: number, max: number, edge: number, signal?: AbortSignal }) => Promise<Drawn> }} PdfPages
 *   from: the first page, 1-based (default 1); max: how many at most; edge: the longest side in px */

/**
 * The running plugin's pages(), or null. The kind isn't named: the first running registration is used, and plugins start in
 * rank order, so annai's official one comes first. A plugin's Error in words (a locked PDF) is its answer; a crash counts
 * against it, as a tool's does (spec §5.5).
 * @param {import('./registry.js').Registry | null | undefined} registry @returns {PdfPages | null}
 */
export function runningPdfPages(registry) {
  const found = registry?.entries('pdf-pages').find((e) => typeof e.item?.pages === 'function');
  if (!registry || !found) return null;
  const { pluginId, item } = found;
  return {
    pluginId,
    pages: async (bytes, o) => {
      try {
        const out = await item.pages(bytes, o);
        registry.succeeded(pluginId);
        return out;
      } catch (e) {
        if (!isPluginBug(e)) throw e;
        registry.fail(pluginId, /* en */ 'pdf pages', e);
        throw new PluginError(pluginId, /* en */ `its PDF pages failed: ${/** @type {any} */ (e)?.message ?? e}`, { cause: e });
      }
    },
  };
}
