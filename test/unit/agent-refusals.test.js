import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { readRefusal, limitImages } from '../../src/core/agent/refusals.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { modelOf } from '../../src/core/llm/config.js';

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

const photo = async (/** @type {any} */ k) => k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };

test('a refused photo is fixed and retried; the lesson is saved on the model; a reload sends the same', async () => {
  const k = await agentKit([[{ error: 'image', status: 400, message: 'image exceeds 5 MB maximum: 6000000 bytes > 300 bytes' }, sleep]]);
  await photo(k);
  k.agent.send('What is this?', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.equal(k.notices.length, 0);
  const [replace] = await k.events(['photo.replace']);
  assert.ok(replace);
  const [msg] = await k.events(['msg.user']);
  assert.equal(replace.data.old, msg.data.images[0].hash);
  assert.equal(k.codec.calls.at(-1).maxBytes, 300);
  const sent = k.requests.at(-1).messages.at(-1).parts.find((/** @type {any} */ p) => p.type === 'image');
  assert.equal(sent.hash, replace.data.new);
  assert.equal(modelOf((await k.llm.config()).models['m-0']).images.maxBytes, 300);
  assert.equal(await k.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(replace.data.old)), false);
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, k.agent.transcript.messages);
});

test("an unfamiliar refusal is read by the utility model; one it can't read ends the turn with a card", async () => {
  const k = await agentKit([[{ error: 'image', status: 400, message: 'Picture too chonky for this model' }, sleep]], {
    utility: [{ toolCalls: [{ name: 'limits', input: { maxEdge: 512 } }] }],
  });
  await photo(k);
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.equal(k.codec.calls.at(-1).maxEdge, 512);
  const k2 = await agentKit([[{ error: 'image', status: 400, message: 'Picture too chonky' }]], { utility: [{ text: 'No idea.' }] });
  await photo(k2);
  k2.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k2.agent.idle();
  assert.equal(k2.notices[0].title, "Shiori couldn't send the photo");
  assert.equal(k2.notices.length, 1, 'one card says what happened');
});

test('a utility model that refuses the forced tool (it thinks) is asked again without forcing it', async () => {
  const k = await agentKit([[{ error: 'image', status: 400, message: 'Picture too chonky for this model' }, sleep]], {
    utility: [{ error: 'bad-request', status: 400, message: 'tool_choice that forces tool use is not supported with thinking.' }, { toolCalls: [{ name: 'limits', input: { maxEdge: 512 } }] }],
  });
  await photo(k);
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.equal(k.codec.calls.at(-1).maxEdge, 512);
  assert.equal(k.notices.length, 0);
});

test('the same refusal again, after a repair, is not looped on', async () => {
  const k = await agentKit([[{ error: 'image', status: 400, message: 'image exceeds 5 MB maximum: 6000000 bytes > 300 bytes' }]]);
  await photo(k);
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.ok(k.requests.length <= 3);
  assert.equal(k.notices[0].title, "Shiori couldn't send the photo");
});

test('a format no encoder here can make: a card names it', async () => {
  const k = await agentKit([[{ error: 'image', status: 400, message: 'Only image/avif is supported.' }]], { codecFormats: ['image/webp', 'image/jpeg'] });
  await photo(k);
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.match(k.notices[0].body, /AVIF/);
});

test("photos over a model's count go as stubs, the oldest first", async () => {
  const k = await agentKit([[sleep]], { models: [{ images: { maxCount: 1 } }] });
  await photo(k);
  k.agent.send('Two', { photos: [{ path: '/trip/files/p.webp' }, { path: '/trip/files/p.webp', region: [0, 0, 0.5, 0.5] }] });
  await k.agent.idle();
  const parts = k.requests[0].messages.at(-1).parts;
  assert.deepEqual(parts.map((/** @type {any} */ p) => p.type), ['text', 'text', 'image']);
  assert.equal(parts[1].text, '[photo /trip/files/p.webp, not sent again: read it to see it]');
});
