import { pages, PackedData } from '../../../plugins-official/pdf-pages/index.js';

const fixture = async (/** @type {string} */ n) => new Uint8Array(await (await fetch(`/test/fixtures/pdf/${n}`)).arrayBuffer());

/**
 * The share of dark pixels in a page picture, and the colour at points given as fractions of its width and height: R (red), B (blue),
 * W (white) or ?. @param {{ type: string, bytes: Uint8Array }} p @param {[number, number][]} [points]
 */
async function look(p, points = []) {
  const bitmap = await createImageBitmap(new Blob([/** @type {BlobPart} */ (p.bytes)], { type: p.type }));
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
  g.drawImage(bitmap, 0, 0);
  const { data } = g.getImageData(0, 0, bitmap.width, bitmap.height);
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 384) dark++;
  const colours = points.map(([x, y]) => {
    const i = (Math.floor(y * bitmap.height) * bitmap.width + Math.floor(x * bitmap.width)) * 4;
    const [red, green, blue] = [data[i], data[i + 1], data[i + 2]];
    return red > 200 && green > 200 && blue > 200 ? 'W' : red > 128 && blue < 128 ? 'R' : blue > 128 && red < 128 ? 'B' : '?';
  });
  return { dark: dark / (data.length / 4), colours };
}

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('the booking PDF: 3 pages, each a JPEG 1600 px on its longest side, with its words in dark pixels', async () => {
    const r = await pages(await fixture('booking.pdf'), { max: 10, edge: 1600 });
    assert.equal(r.count, 3);
    assert.equal(r.pages.length, 3);
    for (const p of r.pages) {
      assert.equal(p.type, 'image/jpeg');
      assert.equal(Math.max(p.width, p.height), 1600);
      assert.ok((await look(p)).dark > 0.0004, 'text was drawn'); // page 3 is one line: about 0.001
    }
  });
  test('max and from pick the pages: from 2, max 1 is page 2 alone, and count is still 3', async () => {
    const r = await pages(await fixture('booking.pdf'), { from: 2, max: 1, edge: 400 });
    assert.equal(r.count, 3);
    assert.equal(r.pages.length, 1);
  });
  test('a scanned page, a picture alone: red on its left, blue on its right', async () => {
    const [p] = (await pages(await fixture('scan.pdf'), { max: 1, edge: 800 })).pages;
    assert.deepEqual((await look(p, [[0.25, 0.5], [0.75, 0.5]])).colours, ['R', 'B']);
  });
  test("a page with nothing drawn on it isn't sent: count counts it, and blank names it", async () => {
    const r = await pages(await fixture('blank.pdf'), { max: 10, edge: 400 });
    assert.equal(r.count, 2);
    assert.equal(r.pages.length, 1);
    assert.deepEqual(r.blank, [2]);
  });
  test("PDF.js's CMaps come from the plugin's one pack, by name: a Japanese one, as PDF.js asks for it", async () => {
    const data = new PackedData({ standardFontDataUrl: '/plugins-official/pdf-pages/vendor/pdfjs/standard_fonts/' });
    const bytes = await data.fetch({ kind: 'cMapUrl', filename: 'UniJIS-UCS2-H.bcmap' });
    assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 100);
    await assert.rejects(data.fetch({ kind: 'cMapUrl', filename: 'Nothing-H.bcmap' }));
  });
  test('the bytes given are still whole afterwards', async () => {
    const bytes = await fixture('booking.pdf');
    const length = bytes.byteLength;
    await pages(bytes, { max: 1, edge: 200 });
    assert.equal(bytes.byteLength, length);
  });
  test("bytes that aren't a PDF are an answer in words, not a crash", async () => {
    await assert.rejects(pages(new TextEncoder().encode('%PDF-1.4 booking'), { max: 1, edge: 100 }), (/** @type {any} */ e) => !(e instanceof TypeError) && /PDF/.test(e.message));
  });
  test('a stopped signal stops it', async () => {
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(pages(await fixture('booking.pdf'), { max: 3, edge: 1600, signal: stop.signal }));
  });
}
