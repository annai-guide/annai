import { canEncode, encodePhoto } from '../../../src/ui/photo-codec.js';

const base = { formats: ['image/webp', 'image/jpeg'], quality: 0.9, maxEdge: null, maxBytes: null, maxPixels: 4096 * 4096 };
/** @param {string} name */
const photo = async (name) => (await fetch(`/test/fixtures/photos/${name}`)).blob();

/**
 * The colour of one pixel of an encoded photo: R (red), B (blue), W (white) or ?.
 * @param {{ bytes: Uint8Array, type: string }} r @param {number} x @param {number} y
 */
async function colour(r, x, y) {
  const bitmap = await createImageBitmap(new Blob([/** @type {BlobPart} */ (r.bytes)], { type: r.type }));
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
  g.drawImage(bitmap, 0, 0);
  const [red, green, blue] = g.getImageData(x, y, 1, 1).data;
  return red > 200 && green > 200 && blue > 200 ? 'W' : red > 128 ? 'R' : blue > 128 ? 'B' : '?';
}

/** A noisy image, which compresses badly. @param {number} width @param {number} height */
async function noise(width, height) {
  const c = new OffscreenCanvas(width, height);
  const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
  const img = g.createImageData(width, height);
  for (let i = 0; i < img.data.length; i++) img.data[i] = (i % 4 === 3) ? 255 : (Math.imul(i, 2654435761) >>> 24);
  g.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('JPEG and PNG can always be written; other formats are tested, not assumed', async () => {
    assert.equal(await canEncode('image/jpeg'), true);
    assert.equal(await canEncode('image/png'), true);
    assert.equal(await canEncode('image/x-annai-test'), false);
  });

  test('photos come out upright, turned by their EXIF orientation exactly once', async () => {
    const side = await encodePhoto(await photo('portrait.jpg'), base);
    assert.deepEqual([side.width, side.height], [48, 64]);
    assert.equal(await colour(side, 2, 2), 'R');
    assert.equal(await colour(side, 45, 61), 'B');
    const flipped = await encodePhoto(await photo('upside-down.jpg'), base);
    assert.deepEqual([flipped.width, flipped.height], [64, 48]);
    assert.equal(await colour(flipped, 2, 2), 'B');
    assert.equal(await colour(flipped, 61, 45), 'R');
  });

  test('the first format on the list that this browser can write is used', async () => {
    const r = await encodePhoto(await photo('plain.jpg'), base);
    assert.equal(r.type, (await canEncode('image/webp')) ? 'image/webp' : 'image/jpeg');
    assert.equal((await encodePhoto(await photo('plain.jpg'), { ...base, formats: ['image/x-annai-test', 'image/jpeg'] })).type, 'image/jpeg');
  });

  test('transparent pixels become white in a JPEG', async () => {
    const c = new OffscreenCanvas(40, 40);
    const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
    g.fillStyle = '#f00';
    g.fillRect(0, 0, 20, 40);
    const r = await encodePhoto(await c.convertToBlob({ type: 'image/png' }), { ...base, formats: ['image/jpeg'] });
    assert.equal(await colour(r, 5, 20), 'R');
    assert.equal(await colour(r, 35, 20), 'W');
  });

  test('a size limit lowers the quality, then the size, until the photo fits', async () => {
    const r = await encodePhoto(await noise(600, 450), { ...base, maxBytes: 30_000 });
    assert.ok(r.bytes.length <= 30_000, `${r.bytes.length} bytes`);
    assert.ok(r.width < 600 && r.width / r.height > 1.3 && r.width / r.height < 1.37, `${r.width}x${r.height}`);
  });

  test('photos are never enlarged, and stay within the edge and pixel limits', async () => {
    const small = await encodePhoto(await photo('plain.jpg'), { ...base, maxEdge: 2000 });
    assert.deepEqual([small.width, small.height], [64, 48]);
    const edge = await encodePhoto(await noise(400, 300), { ...base, maxEdge: 100 });
    assert.deepEqual([edge.width, edge.height], [100, 75]);
    const pixels = await encodePhoto(await noise(400, 300), { ...base, maxPixels: 10_000 });
    assert.ok(pixels.width * pixels.height <= 10_000, `${pixels.width}x${pixels.height}`);
  });

  test("a photo the browser can't read is refused, never drawn blank", async () => {
    await assert.rejects(encodePhoto(new Blob(['not a photo'], { type: 'image/jpeg' }), base));
  });

  test('encodePhoto: a crop draws only that part of the photo', async () => {
    const c = new OffscreenCanvas(200, 100);
    const g = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
    g.fillStyle = '#f00';
    g.fillRect(0, 0, 100, 100);
    g.fillStyle = '#00f';
    g.fillRect(100, 0, 100, 100);
    const r = await encodePhoto(await c.convertToBlob({ type: 'image/png' }), { ...base, formats: ['image/png'], crop: { x: 100, y: 0, width: 100, height: 100 } });
    assert.equal(r.width, 100);
    assert.equal(r.height, 100);
    assert.equal(await colour(r, 10, 50), 'B');
  });
}
