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

test("limitImages: a PDF's page pictures in one message go from the last page back, and each stub names its page (the re-check of reading-files)", () => {
  const page = (/** @type {number} */ n) => ({ type: /** @type {const} */ ('image'), mediaType: 'image/jpeg', data: 'AAAA', hash: `h${n}`, page: n });
  const messages = [
    { role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: '[a PDF: booking.pdf] Its pages as pictures, as you can\'t read PDFs: pages 1–3 of 3.' }, page(1), page(2), page(3)] },
    { role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('image'), mediaType: 'image/webp', data: 'BBBB', path: '/trip/files/new.webp' }] },
  ];
  const out = limitImages(messages, 3);
  assert.deepEqual(out[0].parts.map((/** @type {any} */ p) => p.page ?? p.text), ['[a PDF: booking.pdf] Its pages as pictures, as you can\'t read PDFs: pages 1–3 of 3.', 1, 2, '[page 3 of the PDF above, not sent: this model takes fewer pictures at a time]']);
  assert.equal(out[1].parts[0].type, 'image', 'the newest photo still wins');
});

test("limitImages: within one message, its own photos stay before its PDF's pages, which give way from the last page (round 4)", () => {
  const page = (/** @type {number} */ n) => ({ type: /** @type {const} */ ('image'), mediaType: 'image/jpeg', data: 'AAAA', hash: `h${n}`, page: n });
  const photo = { type: /** @type {const} */ ('image'), mediaType: 'image/webp', data: 'BBBB', path: '/trip/files/menu.webp' };
  const messages = [{ role: /** @type {const} */ ('user'), parts: [photo, { type: /** @type {const} */ ('text'), text: '[a PDF: booking.pdf] …' }, page(1), page(2), page(3)] }];
  const out = limitImages(messages, 2);
  assert.deepEqual(out[0].parts.map((/** @type {any} */ p) => (p.type === 'image' ? p.page ?? p.path : p.text)), ['/trip/files/menu.webp', '[a PDF: booking.pdf] …', 1, '[page 2 of the PDF above, not sent: this model takes fewer pictures at a time]', '[page 3 of the PDF above, not sent: this model takes fewer pictures at a time]']);
});

test('a photo sent again after the limit still goes, at its earliest place (rounds 7 and 8)', () => {
  const text = (/** @type {string} */ t) => ({ type: /** @type {const} */ ('text'), text: t });
  const photo = (/** @type {string} */ hash, /** @type {string} */ path) => ({ type: /** @type {const} */ ('image'), mediaType: 'image/webp', data: 'AAAA', hash, path });
  const msgs = [
    { role: /** @type {const} */ ('user'), parts: [text('Here is the menu'), photo('hA', '/trip/files/menu.webp')] },
    { role: /** @type {const} */ ('user'), parts: [text('And the hotel'), photo('hB', '/trip/files/hotel.webp')] },
    { role: /** @type {const} */ ('user'), parts: [text('Look at the menu again'), photo('hA', '/trip/files/menu.webp')] },
  ];
  const out = limitImages(msgs, 1);
  // Round 8: the newest picture is kept, and sent at its earliest place; the later copy says so.
  assert.deepEqual(out.map((m) => m.parts.filter((p) => p.type === 'image').map((/** @type {any} */ p) => p.hash)), [['hA'], [], []]);
});

test("limitImages counts each distinct picture once: a picture that fits isn't dropped for a copy (round 8, S6, B1, B3)", () => {
  const img = (/** @type {string} */ hash, /** @type {any} */ extra = {}) => ({ type: /** @type {const} */ ('image'), mediaType: 'image/jpeg', data: 'AAAA', hash, ...extra });
  const text = (/** @type {string} */ t) => ({ type: /** @type {const} */ ('text'), text: t });
  const hashes = (/** @type {any[]} */ out) => out.map((m) => m.parts.filter((/** @type {any} */ p) => p.type === 'image').map((/** @type {any} */ p) => p.hash));
  // S6: a sign photo, a PDF's 3 kept pages, and a read with the same 3 pages, at 4.
  const s6 = [
    { role: /** @type {const} */ ('user'), parts: [text('the sign'), img('X', { path: '/trip/files/sign.webp' })] },
    { role: /** @type {const} */ ('user'), parts: [text('[a PDF: booking.pdf] Its pages'), img('P1', { page: 1 }), img('P2', { page: 2 }), img('P3', { page: 3 })] },
    { role: /** @type {const} */ ('user'), parts: [text('read again'), img('P1', { page: 1 }), img('P2', { page: 2 }), img('P3', { page: 3 })] },
  ];
  const out = limitImages(s6, 4);
  assert.deepEqual(hashes(out), [['X'], ['P1', 'P2', 'P3'], []]);
  assert.equal(/** @type {any} */ (out[2].parts[1]).text, '[page 1 of the PDF, the same picture as above]');
  // B1: X, Y, Y at 2: both go.
  const b1 = [{ role: /** @type {const} */ ('user'), parts: [img('X', { path: '/x.webp' })] }, { role: /** @type {const} */ ('user'), parts: [img('Y', { path: '/y.webp' })] }, { role: /** @type {const} */ ('user'), parts: [img('Y', { path: '/y.webp' })] }];
  assert.deepEqual(hashes(limitImages(b1, 2)), [['X'], ['Y'], []]);
  // B3: a message's own photo stays before its PDF's pages, and goes again later as "the same".
  const b3 = [{ role: /** @type {const} */ ('user'), parts: [img('P', { path: '/p.webp' }), text('[a PDF]'), img('h1', { page: 1 }), img('h2', { page: 2 })] }, { role: /** @type {const} */ ('user'), parts: [img('P', { path: '/p.webp' }), text('again')] }];
  assert.deepEqual(hashes(limitImages(b3, 2)), [['P', 'h1'], []]);
});

test("a size repair never deletes a picture a kept reading or a tool result in this conversation still names (round 10)", async () => {
  const readPdf = { toolCalls: [{ name: 'read', input: { path: '/trip/files/booking.pdf' } }] };
  const k = await agentKit([[readPdf, { error: 'image', status: 400, message: 'image exceeds 5 MB maximum: 6000000 bytes > 300 bytes' }, done]], { models: [{ input: ['text', 'image'] }] });
  await k.ws.write(k.trip, '/files/booking.pdf', new TextEncoder().encode('%PDF-1.4 booking'), { author: 'user', type: 'application/pdf' });
  k.registry.add('pdf-pages', 'pdf-pages', { id: 'fake', pages: async () => ({ count: 1, pages: [{ type: 'image/jpeg', bytes: Uint8Array.from({ length: 400 }, (_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : i % 251)), width: 10, height: 10 }] }) }); // over the 300 bytes the model will take
  k.agent.send('Read it');
  await k.agent.idle();
  const [kept] = await k.events(['reading']);
  assert.ok((await k.events(['photo.replace'])).some((e) => e.data.old === kept.data.images[0].hash), 'the page was sent again as a smaller copy');
  assert.equal(await k.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(kept.data.images[0].hash)), true, 'the kept page stays');
});

test("a size repair never deletes content the trip's file history still names: an earlier version can still be restored (round 11)", async () => {
  const k = await agentKit([[done, { error: 'image', status: 400, message: 'image exceeds 5 MB maximum: 6000000 bytes > 3 bytes' }, done]]);
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  k.agent.send('What is this?', { photos: [{ path: '/trip/files/p.webp' }] });
  await k.agent.idle();
  const [msg] = await k.events(['msg.user']);
  const sent = msg.data.images[0].hash;
  const was = (await k.ws.read(k.trip, '/files/p.webp')).entry.hash;
  await k.ws.write(k.trip, '/files/p.webp', new TextEncoder().encode('640x480'), { author: 'user', type: 'image/webp', meta: { width: 640, height: 480 } });
  k.agent.send('And now?');
  await k.agent.idle();
  assert.ok((await k.events(['photo.replace'])).some((e) => e.data.old === sent), 'the sent copy was replaced');
  assert.equal(await k.store.tx(['blobs'], 'readonly', (t) => t.hasBlob(was)), true, "the file's earlier version is still stored");
  await k.ws.restore(k.trip, '/files/p.webp', was, { author: 'user' });
  assert.equal((await k.ws.read(k.trip, '/files/p.webp')).entry.hash, was);
});
