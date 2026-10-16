import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ingestPhoto, photoSettings, fitSize, photoName, isPhotoType, MAX_CANVAS_PIXELS, DEFAULT_PHOTO_SETTINGS } from '../../src/core/photos.js';

/** @param {string} name */
const fixture = async (name) => new Uint8Array(await readFile(new URL(`../fixtures/photos/${name}`, import.meta.url)));
/** A picked file: a Blob with a name. @param {string} fixtureName @param {string} [name] */
const picked = async (fixtureName, name = fixtureName) => Object.assign(new Blob([/** @type {BlobPart} */ (await fixture(fixtureName))]), { name });
const bigSur = { lat: 36.2219, lng: -121.7598 };

async function trip() {
  const store = createMemoryStore();
  await store.tx(['scopes'], 'readwrite', (t) => t.putScope({ id: 'trip-1', kind: 'trip', title: 'T', status: 'active', created: 0, updated: 0, format: 1 }));
  return new Workspace(store);
}

/**
 * A stand-in for the browser's encoder: it records what it was asked for and returns
 * `size` bytes of `type`, or throws like a browser that can't read the photo.
 * @param {{ type?: string, width?: number, height?: number, size?: number } | null} [result]
 */
function fakeCodec(result = {}) {
  /** @type {{ type: string, opts: any }[]} */
  const calls = [];
  return {
    calls,
    /** @param {Blob} source @param {any} opts */
    async encode(source, opts) {
      calls.push({ type: source.type, opts });
      if (result === null) throw new Error('The source image could not be decoded.');
      return { bytes: new Uint8Array(result.size ?? 1000), type: result.type ?? 'image/webp', width: result.width ?? 48, height: result.height ?? 64 };
    },
  };
}

test('settings: defaults, and anything missing or out of range falls back to them', () => {
  assert.deepEqual(photoSettings({}), { keepOriginals: false, ingest: { formats: ['image/webp', 'image/jpeg'], quality: 0.9, maxEdge: null, maxBytes: null } });
  assert.deepEqual(DEFAULT_PHOTO_SETTINGS.ingest.formats, ['image/webp', 'image/jpeg']);
  const s = photoSettings({ photos: { keepOriginals: true, ingest: { formats: [], quality: 7, maxEdge: 2000, maxBytes: 'big' } } });
  assert.deepEqual(s, { keepOriginals: true, ingest: { formats: ['image/webp', 'image/jpeg'], quality: 0.9, maxEdge: 2000, maxBytes: null } });
  assert.deepEqual(photoSettings({ photos: { ingest: { formats: ['image/jpeg'], quality: 0.8, maxBytes: 2_000_000 } } }).ingest,
    { formats: ['image/jpeg'], quality: 0.8, maxEdge: null, maxBytes: 2_000_000 });
});

test('fitSize never enlarges, keeps the shape, and stays within the edge and pixel limits', () => {
  assert.deepEqual(fitSize(100, 50, 2000, null), { width: 100, height: 50 });
  assert.deepEqual(fitSize(4000, 3000, 2000, null), { width: 2000, height: 1500 });
  assert.deepEqual(fitSize(4032, 3024, null, MAX_CANVAS_PIXELS), { width: 4032, height: 3024 }); // 12 MP fits
  const big = fitSize(8064, 6048, null, MAX_CANVAS_PIXELS); // 48 MP does not
  assert.ok(big.width * big.height <= MAX_CANVAS_PIXELS);
  assert.equal(Math.round((big.width / big.height) * 100), 133);
  assert.deepEqual(fitSize(1, 1, 16, 16), { width: 1, height: 1 });
});

test('photo names: when it was taken if known, otherwise its own name, always a safe file name', () => {
  assert.equal(photoName('2026-11-26T19:04:12-08:00', 'IMG_1234.HEIC', 'image/webp'), '2026-11-26-1904.webp');
  assert.equal(photoName(undefined, 'IMG_1234.HEIC', 'image/jpeg'), 'IMG_1234.jpg');
  assert.equal(photoName(undefined, 'a/b\\c.png', 'image/png'), 'a-b-c.png');
  assert.equal(photoName(undefined, '..', 'image/webp'), 'photo.webp');
  assert.equal(photoName(undefined, '', 'image/webp'), 'photo.webp');
});

test('only real photo formats go through ingest', () => {
  for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif']) assert.equal(isPhotoType(t), true, t);
  for (const t of ['image/gif', 'image/svg+xml', 'application/pdf', '']) assert.equal(isPhotoType(t), false, t);
});

test('a sideways JPEG is stored encoded and upright, named by when it was taken, with its time and place', async () => {
  const ws = await trip();
  const codec = fakeCodec();
  const { entry, note } = await ingestPhoto(ws, 'trip-1', await picked('portrait.jpg', 'IMG_1234.JPG'), { settings: photoSettings({}), codec });
  assert.equal(note, null);
  assert.equal(entry.path, '/files/2026-11-26-1904.webp');
  assert.equal(entry.type, 'image/webp');
  assert.equal(entry.source, 'IMG_1234.JPG');
  assert.deepEqual(entry.meta, { width: 48, height: 64, taken: '2026-11-26T19:04:12-08:00', place: bigSur });
  assert.equal(codec.calls.length, 1);
  assert.equal(codec.calls[0].type, 'image/jpeg');
  assert.deepEqual(codec.calls[0].opts, { formats: ['image/webp', 'image/jpeg'], quality: 0.9, maxEdge: null, maxBytes: null, maxPixels: MAX_CANVAS_PIXELS });
});

test('a turned JPEG is never kept as it is, even when encoding makes it larger', async () => {
  const ws = await trip();
  const { entry } = await ingestPhoto(ws, 'trip-1', await picked('portrait.jpg'), { settings: photoSettings({}), codec: fakeCodec({ size: 1_000_000 }) });
  assert.equal(entry.type, 'image/webp'); // keeping it would need its EXIF to show the right way up
});

test('an upright JPEG on the format list is kept as it is, minus its EXIF, when encoding would not shrink it', async () => {
  const ws = await trip();
  const { entry } = await ingestPhoto(ws, 'trip-1', await picked('upright.jpg'), { settings: photoSettings({}), codec: fakeCodec({ size: 100_000 }) });
  assert.equal(entry.path, '/files/2026-11-26-1230.jpg');
  assert.equal(entry.type, 'image/jpeg');
  assert.deepEqual((await ws.read('trip-1', entry.path))?.bytes, await fixture('plain.jpg')); // same image, no EXIF, no hidden location
  assert.deepEqual(entry.meta, { width: 64, height: 48, taken: '2026-11-26T12:30:00-08:00', place: bigSur }); // the place is kept beside it
});

test('when encoding does shrink it, the encoding wins', async () => {
  const ws = await trip();
  const { entry } = await ingestPhoto(ws, 'trip-1', await picked('upright.jpg'), { settings: photoSettings({}), codec: fakeCodec({ size: 10, width: 64, height: 48 }) });
  assert.equal(entry.type, 'image/webp');
  assert.equal(entry.size, 10);
});

test('photos over the edge or size limit are encoded within it', async () => {
  const ws = await trip();
  const settings = photoSettings({ photos: { ingest: { maxEdge: 32 } } });
  const codec = fakeCodec({ size: 1_000_000, width: 32, height: 24 });
  const { entry } = await ingestPhoto(ws, 'trip-1', await picked('upright.jpg'), { settings, codec });
  assert.equal(entry.type, 'image/webp');
  assert.equal(codec.calls[0].opts.maxEdge, 32);
  assert.deepEqual([entry.meta?.width, entry.meta?.height], [32, 24]);
});

test('a format not on the list is converted even when that makes it larger', async () => {
  const ws = await trip();
  const { entry } = await ingestPhoto(ws, 'trip-1', await picked('screenshot.png'), { settings: photoSettings({}), codec: fakeCodec({ size: 1_000_000, width: 64, height: 48 }) });
  assert.equal(entry.path, '/files/screenshot.webp');
  assert.equal(entry.type, 'image/webp');
});

test("a photo this browser can't read is kept as it is, with a note, never lost", async () => {
  const ws = await trip();
  const { entry, note } = await ingestPhoto(ws, 'trip-1', await picked('portrait.heic', 'IMG_9.HEIC'), { settings: photoSettings({}), codec: fakeCodec(null) });
  assert.equal(entry.path, '/files/2026-11-26-1904.heic');
  assert.equal(entry.type, 'image/heic');
  assert.deepEqual(entry.meta, { width: 48, height: 64, taken: '2026-11-26T19:04:12-08:00', place: bigSur, original: true });
  assert.match(String(note), /can't convert IMG_9\.HEIC/);
});

test('Keep originals stores the photo exactly as taken, without encoding it', async () => {
  const ws = await trip();
  const codec = fakeCodec();
  const { entry } = await ingestPhoto(ws, 'trip-1', await picked('portrait.jpg'), { settings: photoSettings({ photos: { keepOriginals: true } }), codec });
  assert.equal(codec.calls.length, 0);
  assert.equal(entry.path, '/files/2026-11-26-1904.jpg');
  assert.deepEqual((await ws.read('trip-1', entry.path))?.bytes, await fixture('portrait.jpg'));
  assert.deepEqual(entry.meta, { width: 48, height: 64, taken: '2026-11-26T19:04:12-08:00', place: bigSur, original: true });
});

test('two photos taken in the same minute each get their own file', async () => {
  const ws = await trip();
  const settings = photoSettings({});
  const a = await ingestPhoto(ws, 'trip-1', await picked('upright.jpg'), { settings, codec: fakeCodec({ size: 100_000 }) });
  const b = await ingestPhoto(ws, 'trip-1', await picked('upright.jpg'), { settings, codec: fakeCodec({ size: 100_000 }) });
  assert.deepEqual([a.entry.path, b.entry.path], ['/files/2026-11-26-1230.jpg', '/files/2026-11-26-1230-2.jpg']);
});

test('a photo whose header gives no real size is stored without one, never with 0', async () => {
  const ws = await trip();
  const b = (await fixture('plain.jpg')).slice();
  const sof = Buffer.from(b).indexOf(Buffer.from([0xff, 0xc0])); // the frame header
  new DataView(b.buffer).setUint16(sof + 5, 0); // its height: a JPEG may leave it to a later DNL segment
  const file = Object.assign(new Blob([/** @type {BlobPart} */ (b)]), { name: 'odd.jpg' });
  const { entry } = await ingestPhoto(ws, 'trip-1', file, { settings: photoSettings({ photos: { keepOriginals: true } }), codec: fakeCodec() });
  assert.equal(entry.meta?.width, undefined);
  assert.equal(entry.meta?.height, undefined);
});
