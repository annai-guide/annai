import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestLimits, fits, PhotoCopies, sizeLine } from '../../src/core/request-photos.js';
import { photoSettings } from '../../src/core/photos.js';
import { utf8 } from '../../src/core/bytes.js';

const request = photoSettings({}).request;

test('request settings default to WebP or JPEG, quality 0.9, 2000 px, 1 MiB (spec §4.8)', () => {
  assert.deepEqual(request, { formats: ['image/webp', 'image/jpeg'], quality: 0.9, maxEdge: 2000, maxBytes: 1024 * 1024 });
});

test('the limits are the stricter of the request settings and what the model accepts', () => {
  assert.deepEqual(requestLimits(request, { formats: ['image/jpeg', 'image/png'], maxEdge: 8000, maxBytes: 5 * 2 ** 20, maxCount: 100 }),
    { formats: ['image/jpeg'], quality: 0.9, maxEdge: 2000, maxBytes: 2 ** 20, maxCount: 100 });
  assert.deepEqual(requestLimits({ ...request, maxEdge: null }, { maxEdge: 1568 }).maxEdge, 1568);
  assert.deepEqual(requestLimits(request, { formats: ['image/gif'] }).formats, ['image/gif']);
  assert.deepEqual(requestLimits(request, {}).maxCount, null);
});

test('fits: format, longest edge and size', () => {
  const l = requestLimits(request, {});
  assert.equal(fits({ type: 'image/webp', width: 2000, height: 1500, size: 500_000 }, l), true);
  assert.equal(fits({ type: 'image/webp', width: 4032, height: 3024, size: 500_000 }, l), false);
  assert.equal(fits({ type: 'image/heic', width: 100, height: 100, size: 1000 }, l), false);
  assert.equal(fits({ type: 'image/jpeg', size: 3 * 2 ** 20 }, l), false);
});

/** A codec that "decodes" a source written as "WxH" and reports what it was asked. */
function fakeCodec() {
  const calls = [];
  return {
    calls,
    async encode(/** @type {Blob} */ blob, /** @type {any} */ o) {
      calls.push(o);
      const [w, h] = (await blob.text()).split('x').map(Number);
      const box = o.crop ?? { width: w, height: h };
      const s = Math.min(1, (o.maxEdge ?? Infinity) / Math.max(box.width, box.height));
      const width = Math.floor(box.width * s);
      const height = Math.floor(box.height * s);
      return { bytes: utf8(`${width}x${height}:${JSON.stringify(o.crop ?? null)}`), type: o.formats[0], width, height };
    },
  };
}

test('a photo within the limits goes as it is; one over them is copied once, and the copy reused', async () => {
  const codec = fakeCodec();
  const copies = new PhotoCopies({ codec, read: async () => utf8('4032x3024') });
  const l = requestLimits(request, {});
  const small = await copies.copy({ hash: 'small', type: 'image/webp', width: 1600, height: 1200, size: 300_000 }, l);
  assert.deepEqual(small, { hash: 'small', mediaType: 'image/webp', width: 1600, height: 1200, made: false });
  const big = { hash: 'big', type: 'image/webp', width: 4032, height: 3024, size: 3_000_000 };
  const first = await copies.copy(big, l);
  assert.equal(first.made, true);
  assert.equal(first.width, 2000);
  assert.ok(first.data);
  const again = await copies.copy(big, l);
  assert.equal(again.hash, first.hash);
  assert.equal(again.data, undefined);
  assert.equal(codec.calls.length, 1);
  assert.equal(sizeLine(big, first), '4032×3024, sent as 2000×1500');
  assert.equal(sizeLine({ hash: 's', type: 'image/webp', width: 1600, height: 1200, size: 1 }, small), '1600×1200');
});

test('a crop is always a copy, made from the stored photo', async () => {
  const codec = fakeCodec();
  const copies = new PhotoCopies({ codec, read: async () => utf8('4032x3024') });
  const crop = await copies.copy({ hash: 'big', type: 'image/webp', width: 4032, height: 3024, size: 3_000_000 }, requestLimits(request, {}), { x: 0, y: 0, width: 1000, height: 800 });
  assert.equal(crop.made, true);
  assert.deepEqual(codec.calls[0].crop, { x: 0, y: 0, width: 1000, height: 800 });
  assert.equal(crop.width, 1000);
});
