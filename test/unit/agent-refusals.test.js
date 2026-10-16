import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRefusal, limitImages } from '../../src/core/agent/refusals.js';

test('the usual refusals are read by rules', () => {
  assert.deepEqual(readRefusal('messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6123456 bytes > 5242880 bytes'), { maxBytes: 5242880 });
  assert.deepEqual(readRefusal('Image size exceeds the limit of 20 MB'), { maxBytes: 20_000_000 });
  assert.deepEqual(readRefusal('At least one of the image dimensions exceed max allowed size: 8000 pixels'), { maxEdge: 8000 });
  assert.deepEqual(readRefusal('Invalid MIME type. Only image/jpeg, image/png, image/gif, and image/webp are supported.'), { formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] });
  assert.deepEqual(readRefusal('Too many images in request. Max is 20.'), { maxCount: 20 });
  assert.equal(readRefusal('Something else went wrong'), null);
});

test('limitImages: the oldest photos over the count become stubs', () => {
  const img = (/** @type {string} */ path) => ({ type: /** @type {const} */ ('image'), mediaType: 'image/webp', data: 'x', path });
  const messages = [{ role: /** @type {const} */ ('user'), parts: [img('/trip/files/a.webp'), img('/trip/files/b.webp')] }, { role: /** @type {const} */ ('user'), parts: [img('/trip/files/c.webp')] }];
  const out = limitImages(messages, 2);
  assert.deepEqual(out[0].parts[0], { type: 'text', text: '[photo /trip/files/a.webp, not sent again: read it to see it]' });
  assert.equal(out[0].parts[1].type, 'image');
  assert.equal(out[1].parts[0].type, 'image');
  assert.equal(limitImages(messages, 5), messages);
});
