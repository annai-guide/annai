import { previewOf, imgDrawsPdf } from '../../../src/ui/preview.js';
import { Registry } from '../../../src/core/registry.js';
import { pages } from '../../../plugins-official/pdf-pages/index.js';

const blob = async (/** @type {string} */ path, /** @type {string} */ type) => new Blob([await (await fetch(path)).arrayBuffer()], { type });
const drawn = async (/** @type {string} */ url) => { const img = new Image(); img.src = url; await img.decode(); return img.naturalWidth > 0; };

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('without the plugin, a PDF is itself exactly where this browser\'s <img> draws PDFs, else null (the file card)', async () => {
    const pdf = await blob('/test/fixtures/pdf/booking.pdf', 'application/pdf');
    const url = await previewOf(pdf, { registry: new Registry() });
    assert.equal(url !== null, await imgDrawsPdf());
    if (url) URL.revokeObjectURL(url);
  });
  test('with the plugin, every browser gets the first page as a picture at most 1200 px', async () => {
    const r = new Registry();
    /** @type {any[]} */ const asked = [];
    r.add('pdf-pages', 'pdf-pages', { id: 'pdfjs', pages: (/** @type {any} */ b, /** @type {any} */ o) => { asked.push(o); return pages(b, o); } });
    const url = await previewOf(await blob('/test/fixtures/pdf/booking.pdf', 'application/pdf'), { registry: r });
    assert.ok(url && (await drawn(url)));
    if (!(await imgDrawsPdf())) assert.deepEqual(asked.map((o) => [o.max, o.edge]), [[1, 1200]]);
  });
  test('a photo is itself; text, and a PDF nothing here can draw, are null', async () => {
    const photo = await previewOf(await blob('/test/fixtures/photos/upright.jpg', 'image/jpeg'));
    assert.ok(photo && (await drawn(photo)));
    assert.equal(await previewOf(new Blob(['Booking TEST42'], { type: 'text/plain' })), null);
    const r = new Registry();
    r.add('pdf-pages', 'pdf-pages', { id: 'x', pages: async () => { throw new Error("This file isn't a PDF that can be read."); } });
    const broken = new Blob(['%PDF-1.4 booking'], { type: 'application/pdf' });
    if (!(await imgDrawsPdf())) assert.equal(await previewOf(broken, { registry: r }), null);
  });
  test('a preview stopped while the plugin draws is null, never a throw; and the browser is asked once whether its <img> draws PDFs', async () => {
    assert.equal(imgDrawsPdf(), imgDrawsPdf());
    const r = new Registry();
    r.add('pdf-pages', 'pdf-pages', { id: 'pdfjs', pages });
    const stop = new AbortController();
    stop.abort();
    const url = await previewOf(await blob('/test/fixtures/pdf/booking.pdf', 'application/pdf'), { registry: r, signal: stop.signal });
    if (await imgDrawsPdf()) URL.revokeObjectURL(/** @type {string} */ (url));
    else assert.equal(url, null);
  });
}
