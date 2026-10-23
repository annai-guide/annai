import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
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
/** A reply that reaches the user, then sleeps: a turn of the user's that says nothing is asked again (spec §7.1). */
const done = { toolCalls: [{ name: 'speak', input: { text: 'Got it.' } }, { name: 'sleep', input: {} }] };

test('a refused photo is fixed and retried; the lesson is saved on the model; a reload sends the same', async () => {
  const k = await agentKit([[{ error: 'image', status: 400, message: 'image exceeds 5 MB maximum: 6000000 bytes > 300 bytes' }, done]]);
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
  const k = await agentKit([[{ error: 'image', status: 400, message: 'Picture too chonky for this model' }, done]], {
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
  const k = await agentKit([[{ error: 'image', status: 400, message: 'Picture too chonky for this model' }, done]], {
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
  const k = await agentKit([[done]], { models: [{ images: { maxCount: 1 } }] });
  await photo(k);
  k.agent.send('Two', { photos: [{ path: '/trip/files/p.webp' }, { path: '/trip/files/p.webp', region: [0, 0, 0.5, 0.5] }] });
  await k.agent.idle();
  const parts = k.requests[0].messages.at(-1).parts;
  assert.deepEqual(parts.map((/** @type {any} */ p) => p.type), ['text', 'text', 'image']);
  assert.equal(parts[1].text, '[photo /trip/files/p.webp, not sent again: read it to see it]');
});

test('a refused copy another conversation still names is kept (spec §4.9)', async () => {
  const k = await agentKit([[done, { error: 'image', status: 400, message: 'image exceeds 5 MB maximum: 6000000 bytes > 300 bytes' }, done]]);
  await photo(k);
  const { createTrip } = await import('../../src/core/scopes.js');
  const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
  await k.ws.write(kyoto, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
  await k.agent.open(kyoto);
  k.agent.send('In Kyoto', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  await k.agent.open(k.trip);
  k.agent.send('Here too', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  const [replace] = await k.events(['photo.replace']);
  assert.ok(replace);
  assert.equal(await k.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(replace.data.old)), true);
});

test("a refusal read by the utility model never shows it a key annai keeps", async () => {
  const KEY = 'sk-ant-SECRETKEY1234567890';
  const k = await agentKit([[{ error: 'image', status: 400, message: `Picture too chonky for key ${KEY}` }, done]], {
    utility: [{ toolCalls: [{ name: 'limits', input: { maxEdge: 512 } }] }],
  });
  await k.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('llm:ep-0', KEY));
  await photo(k);
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  const asked = k.requests.find((r) => r.tools?.some((/** @type {any} */ t) => t.name === 'limits'));
  assert.ok(asked);
  assert.doesNotMatch(JSON.stringify(asked), /SECRETKEY/);
});

const turnImages = (/** @type {any} */ t) => t.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'image').map((/** @type {any} */ p) => [p.hash, Boolean(p.missing)]);

test('a photo repaired twice is the same after a reload: the chain of replacements is followed (review C1)', async () => {
  const k = await agentKit([[
    { error: 'image', status: 400, message: 'image exceeds 5 MB maximum: 6000000 bytes > 300 bytes' },
    { error: 'image', status: 400, message: 'At least one of the image dimensions exceed max allowed size: 512 pixels' },
    done,
  ]]);
  await photo(k);
  k.agent.send('What is this?', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.equal((await k.events(['photo.replace'])).length, 2);
  const live = turnImages(k.agent.transcript);
  assert.equal(live.length, 1);
  assert.equal(live[0][1], false);
  assert.deepEqual(turnImages(await Transcript.load(k.store, k.trip)), live);
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, k.agent.transcript.messages);
});

test('a copy whose bytes are gone is made again, never sent as nothing (review C2)', async () => {
  const { createTrip, removeTrip } = await import('../../src/core/scopes.js');
  const k = await agentKit([[done]]);
  const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
  for (const t of [k.trip, kyoto]) await k.ws.write(t, '/files/p.webp', new TextEncoder().encode('4032x3024'), { author: 'user', type: 'image/webp', meta: { width: 4032, height: 3024 } });
  k.agent.send('Here', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  await k.agent.open(kyoto);
  await removeTrip(k.store, k.trip); // its copy goes with it
  k.agent.send('And here', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  const [msg] = await k.store.tx(['events'], 'readonly', (t) => t.listEvents(kyoto, { types: ['msg.user'] }));
  assert.equal(await k.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(msg.data.images[0].hash)), true);
  assert.deepEqual(k.requests.at(-1).messages.at(-1).parts.map((/** @type {any} */ p) => p.type), ['text', 'image']);
});

test('record refuses a log entry that names content that is not stored (review C2)', async () => {
  const { record } = await import('../../src/core/agent/log.js');
  const k = await agentKit([[done]]);
  await assert.rejects(record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'x']], blobs: [{ hash: 'f'.repeat(64), type: 'image/webp' }] }), /not stored/);
});

test('photos are made within every main model that takes them, so a fallback model that learned a limit takes them (review I1)', async () => {
  const k = await agentKit([
    [{ error: 'credit', status: 402 }],
    [{ error: 'image', status: 400, message: 'image exceeds 5 MB maximum: 6000000 bytes > 300 bytes' }, done, done],
  ]);
  await photo(k);
  await k.ws.write(k.trip, '/files/q.webp', new TextEncoder().encode('3000x2000'), { author: 'user', type: 'image/webp', meta: { width: 3000, height: 2000 } });
  k.agent.send('One', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  k.agent.send('Two', { photos: [{ path: '/trip/files/q.webp' }] });
  await k.agent.idle();
  assert.equal(k.notices.length, 0);
  assert.equal(k.codec.calls.at(-1).maxBytes, 300);
});

test('a refusal of too many photos sends the oldest as stubs, and no photo is made again (review I2)', async () => {
  const k = await agentKit([[{ error: 'image', status: 400, message: 'Too many images in request. Max is 1.' }, done]]);
  await photo(k);
  k.agent.send('Two', { photos: [{ path: '/trip/files/p.webp' }, { path: '/trip/files/p.webp', region: [0, 0, 0.5, 0.5] }] });
  await k.agent.idle();
  assert.equal(k.notices.length, 0);
  assert.equal((await k.events(['photo.replace'])).length, 0);
  assert.equal(k.codec.calls.length, 2);
  assert.deepEqual(k.requests.at(-1).messages.at(-1).parts.map((/** @type {any} */ p) => p.type), ['text', 'text', 'image']);
});

test('a refusal that states the limit annai already keeps: a quarter less, once; then a card in plain words (review I3)', async () => {
  const said = 'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6123456 bytes > 5242880 bytes';
  const k = await agentKit([[{ error: 'image', status: 400, message: said }]], { models: [{ images: { maxBytes: 5242880 } }] });
  await photo(k);
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.equal(modelOf((await k.llm.config()).models['m-0']).images.maxBytes, Math.floor((5242880 * 3) / 4));
  assert.equal(k.notices.length, 1);
  assert.equal(k.notices[0].title, "Shiori couldn't send the photo");
  assert.doesNotMatch(k.notices[0].body, /messages\.0\.content/);
  assert.match(k.notices[0].body, /Settings → Photos/);
});

test("a limit the utility model gives that can't be right is not saved (review I5)", async () => {
  const k = await agentKit([[{ error: 'image', status: 400, message: 'Picture too chonky for this model' }]], { utility: [{ toolCalls: [{ name: 'limits', input: { maxEdge: 16, maxBytes: 1 } }] }] });
  await photo(k);
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  assert.deepEqual(modelOf((await k.llm.config()).models['m-0']).images, {});
  assert.equal(k.notices[0].title, "Shiori couldn't send the photo");
});

test("a photo this browser can't read is not dropped quietly: a card says so (review I6)", async () => {
  const k = await agentKit([[done]]);
  await k.ws.write(k.trip, '/files/bad.webp', new TextEncoder().encode('unreadable'), { author: 'user', type: 'image/webp', meta: { width: 4000, height: 3000 } });
  k.agent.send('Look', { photos: [{ path: '/trip/files/bad.webp' }] });
  await k.agent.idle();
  assert.equal(k.notices.length, 1);
  assert.match(k.notices[0].title, /photo/);
  assert.match(k.notices[0].body, /\/trip\/files\/bad\.webp/);
});

test('a model removed while the photo limit it taught is learned needs no limit: nothing is saved, nothing is recreated, no error shows', async () => {
  const { removeModel, readConfig } = await import('../../src/core/llm/config.js');
  const k = await agentKit([[{ error: 'image', status: 400, message: 'Picture too chonky for this model' }, done]], {
    utility: [{ delayMs: 200, toolCalls: [{ name: 'limits', input: { maxEdge: 512 } }] }],
  });
  await photo(k);
  k.agent.send('Look', { photos: [{ path: '/trip/files/p.webp' }] });
  await until(() => k.requests.some((r) => r.tools?.some((/** @type {any} */ t) => t.name === 'limits')));
  // The repair that fails is logged as a warning and the turn goes on without it.
  const was = console.warn;
  /** @type {string[]} */
  const warned = [];
  console.warn = (/** @type {any[]} */ ...a) => { warned.push(a.map(String).join(' ')); };
  try {
    await removeModel(k.ws, 'm-0');
    await k.agent.idle();
  } finally {
    console.warn = was;
  }
  assert.equal((await readConfig(k.ws)).models['m-0'], undefined, 'not recreated');
  assert.deepEqual(warned.filter((w) => /photo repair/.test(w)), [], 'the repair does not fail on a model that is gone');
});
