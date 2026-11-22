import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { limitImages } from '../../src/core/agent/refusals.js';

// The pictures older than a turn's previous one go within 256 KiB as sent (base64): one photo at 192 KiB (photo-budget-next).
/** base64 of a 1 MiB copy, the request cap until 2026-11-21 */
const OLD = 1_398_104;
/** base64 of a 192 KiB copy, the cap since: exactly the budget */
const PHOTO = 262_144;

const text = (/** @type {string} */ t) => ({ type: /** @type {const} */ ('text'), text: t });
/** @param {string} hash @param {number} size @param {Record<string, any>} [extra] */
const img = (hash, size, extra = {}) => ({ type: /** @type {const} */ ('image'), mediaType: 'image/jpeg', data: 'A'.repeat(size), hash, ...extra });
const user = (/** @type {any[]} */ ...parts) => ({ role: /** @type {const} */ ('user'), parts });
const reply = (/** @type {string} */ t) => ({ role: /** @type {const} */ ('assistant'), parts: [text(t)] });
/** What each message sends, a picture by its hash (or page), a stub by its words. @param {any[]} messages */
const shown = (messages) => messages.map((m) => m.parts.flatMap((/** @type {any} */ p) => (p.type === 'image' ? [p.page ? `page ${p.page}` : p.hash] : p.text?.startsWith('[') ? [p.text] : [])));

test("the trip's case: a 1 MiB copy kept from an earlier photo goes again only within the budget, once its turn and the next are over", () => {
  const talk = (/** @type {number} */ size) => [user(text('Look'), img('menu', size, { path: '/trip/files/menu.jpg' })), reply('A menu.'), user(text('And the price?')), reply('12 euros.'), user(text('Thanks'))];
  // A text turn two turns on (the previous turn began at message 2): the copy is a stub that names the file to read.
  assert.deepEqual(shown(limitImages(talk(OLD), null, 2)), [['[photo /trip/files/menu.jpg, not sent again: read it to see it]'], [], [], [], []]);
  // The turn after the photo's (the previous turn began at it): it still goes, as the traveller asks about what she just sent.
  assert.deepEqual(shown(limitImages(talk(OLD), null, 0)), [['menu'], [], [], [], []]);
  // A copy at today's cap fits the budget exactly, so the newest photo keeps going; a byte more doesn't.
  assert.deepEqual(shown(limitImages(talk(PHOTO), null, 2))[0], ['menu']);
  assert.deepEqual(shown(limitImages(talk(PHOTO + 1), null, 2))[0], ['[photo /trip/files/menu.jpg, not sent again: read it to see it]']);
});

test('three new photos in one message all go, over the budget; a fourth, older one becomes the stub with the path she can read', () => {
  const messages = [
    user(text('The station'), img('d', PHOTO, { path: '/trip/files/d.webp' })), reply('Nice.'),
    user(text('And these'), img('a', PHOTO, { path: '/trip/files/a.webp' }), img('b', PHOTO, { path: '/trip/files/b.webp' }), img('c', PHOTO, { path: '/trip/files/c.webp' })),
  ];
  assert.deepEqual(shown(limitImages(messages, null, 2)), [['[photo /trip/files/d.webp, not sent again: read it to see it]'], [], ['a', 'b', 'c']]);
  // The same in the turn after (the previous turn began at them): still all three, and still not the fourth.
  const next = [...messages, reply('Three temples.'), user(text('Which is oldest?'))];
  assert.deepEqual(shown(limitImages(next, null, 2)), [['[photo /trip/files/d.webp, not sent again: read it to see it]'], [], ['a', 'b', 'c'], [], []]);
  // Two turns on, the newest of them goes (newest first: c), and the rest are stubs.
  const later = [...next, reply('The first.'), user(text('Thanks'))];
  assert.deepEqual(shown(limitImages(later, null, 4))[2], ['[photo /trip/files/a.webp, not sent again: read it to see it]', '[photo /trip/files/b.webp, not sent again: read it to see it]', 'c']);
});

test("a picture that drops out changes the request only from its own place: what comes before it is the same, byte for byte, so the provider's cache still reads up to it", () => {
  const SMALL = 100_000;
  const turn = [
    user(text('The bridge'), img('A', SMALL, { path: '/trip/files/a.webp' })), reply('Old stone.'),
    user(text('The gate'), img('B', SMALL, { path: '/trip/files/b.webp' })), reply('Red paint.'),
    user(text('Where now?')),
  ];
  // Turn T (it began at message 4): both older photos fit, 200,000 bytes.
  const before = limitImages(turn, null, 4);
  assert.deepEqual(shown(before), [['A'], [], ['B'], [], []]);
  // Turn T+1 brings a new photo: it and B fit, A no longer does.
  const after = limitImages([...turn, reply('North.'), user(text('This one?'), img('C', SMALL, { path: '/trip/files/c.webp' }))], null, 4);
  assert.deepEqual(shown(after), [['[photo /trip/files/a.webp, not sent again: read it to see it]'], [], ['B'], [], [], [], ['C']]);
  const [x, y] = [JSON.stringify(before), JSON.stringify(after)];
  let i = 0;
  while (x[i] === y[i]) i++;
  const a = JSON.stringify(turn[0].parts[1]);
  assert.ok(i >= x.indexOf(a) && i < x.indexOf(a) + a.length, `the first byte that differs (${i}) is in A's own part`);
  // B, read again in this turn, is kept at its earliest place; the copy in the read says so, and A still goes out for it.
  const reread = limitImages([...turn, reply('North.'), user(text('This one?'), img('C', SMALL, { path: '/trip/files/c.webp' }), img('B', SMALL, { path: '/trip/files/b.webp' }))], null, 4);
  assert.deepEqual(shown(reread), [['[photo /trip/files/a.webp, not sent again: read it to see it]'], [], ['B'], [], [], [], ['C', '[photo /trip/files/b.webp, the same as above]']]);
});

test("the model's count still comes first: of the pictures that always go, the oldest over it is a stub", () => {
  const messages = [user(text('Three'), img('a', 10, { path: '/a.webp' }), img('b', 10, { path: '/b.webp' }), img('c', 10, { path: '/c.webp' }))];
  assert.deepEqual(shown(limitImages(messages, 2, 0)), [['[photo /a.webp, not sent again: read it to see it]', 'b', 'c']]);
  assert.equal(limitImages(messages, 3, 0), messages, 'all within both: the request as it is');
});

test("a PDF's page pictures from an older turn go within the budget from page 1, and the rest say to read the PDF again; the count's own stub stays", () => {
  const PAGE = 100_000;
  const pdf = user(text('[a PDF: booking.pdf] Its pages as pictures, as you can\'t read PDFs: pages 1–3 of 3.'), img('p1', PAGE, { page: 1 }), img('p2', PAGE, { page: 2 }), img('p3', PAGE, { page: 3 }));
  const messages = [pdf, reply('Your hotel.'), user(text('When is check-in?'))];
  assert.deepEqual(shown(limitImages(messages, null, 2))[0], ['[a PDF: booking.pdf] Its pages as pictures, as you can\'t read PDFs: pages 1–3 of 3.', 'page 1', 'page 2', '[page 3 of the PDF above, not sent again: read the PDF to see it]']);
  // In its own turn (or the next), every page goes; past the model's count, the count's words.
  assert.deepEqual(shown(limitImages(messages, null, 0))[0].slice(1), ['page 1', 'page 2', 'page 3']);
  assert.deepEqual(shown(limitImages(messages, 2, 0))[0].slice(1), ['page 1', 'page 2', '[page 3 of the PDF above, not sent: this model takes fewer pictures at a time]']);
});

test('a stub says what brings its picture back: the region of a part, and nothing for a picture no file holds', () => {
  const crop = [user(text('This part'), img('c', OLD, { path: '/trip/files/p.webp', region: [0, 0.25, 0.5, 0.75] })), reply('A sign.'), user(text('Thanks'))];
  assert.deepEqual(shown(limitImages(crop, null, 2))[0], ['[photo /trip/files/p.webp, the part [0,0.25,0.5,0.75], not sent again: read it with that region to see it]']);
  const web = [user(text('[the result] Source: https://example.org/map.png (fetched): an image.'), img('w', OLD)), reply('A map.'), user(text('Thanks'))];
  assert.deepEqual(shown(limitImages(web, null, 2))[0], ['[the result] Source: https://example.org/map.png (fetched): an image.', "[a picture, not sent again: no file holds it, so read can't bring it back]"]);
});

test("older pictures go newest first, and none older than the first that doesn't fit: one that left never comes back by itself", () => {
  const messages = [user(img('small', 10, { path: '/s.webp' })), reply('.'), user(img('big', OLD, { path: '/b.webp' })), reply('.'), user(text('Hi'))];
  assert.deepEqual(shown(limitImages(messages, null, 4)), [['[photo /s.webp, not sent again: read it to see it]'], [], ['[photo /b.webp, not sent again: read it to see it]'], [], []]);
});

test("a request outside a conversation's turns (no cacheAt: a reader's, the recap's) sends every picture, as far as the count", () => {
  const messages = [user(img('a', OLD, { path: '/a.webp' }), img('b', OLD, { path: '/b.webp' }), img('c', OLD, { path: '/c.webp' }))];
  assert.equal(limitImages(messages, null), messages);
});

test("the trip's case through the agent: after a photo of 1 MiB, the second text turn sends it as a stub, and the request is text-sized again", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const done = { toolCalls: [{ name: 'speak', input: { text: 'Got it.' } }, { name: 'sleep', input: {} }] };
  const readIt = { toolCalls: [{ name: 'read', input: { path: '/trip/files/menu.webp' } }] };
  const k = await agentKit([[done, done, readIt, done]]);
  // A traveller's cap of 1 MiB, as every photo had before 2026-11-21: the photo goes as it is.
  await updateAppSettings(k.ws, { photos: { request: { maxBytes: 1024 * 1024 } } });
  await k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('x'.repeat(1_000_000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  k.agent.send('What does it say?', { photos: [{ path: '/trip/files/menu.webp' }] });
  await k.agent.idle();
  k.agent.send('And the price?');
  await k.agent.idle();
  k.agent.send('Thanks');
  await k.agent.idle();
  const images = (/** @type {any} */ r) => r.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'image');
  assert.equal(k.requests.length, 4);
  assert.equal(images(k.requests[0])[0]?.data.length, 1_333_336, 'its own turn');
  assert.equal(images(k.requests[1])[0]?.data.length, 1_333_336, 'the turn after: what she just sent');
  assert.deepEqual(images(k.requests[2]), [], 'two turns on');
  const stub = '[photo /trip/files/menu.webp, not sent again: read it to see it]';
  const at = (/** @type {any} */ r) => r.messages.findIndex((/** @type {any} */ m) => m.parts.some((/** @type {any} */ p) => p.text === stub || p.type === 'image'));
  assert.ok(k.requests[2].messages[at(k.requests[2])].parts.some((/** @type {any} */ p) => p.text === stub));
  assert.ok(JSON.stringify(k.requests[2]).length < 100_000, `${JSON.stringify(k.requests[2]).length} bytes`);
  // The stub is true: she reads the path, and the photo is back for that turn, at its own place, the read's copy said as the same.
  assert.equal(images(k.requests[3]).length, 1);
  assert.equal(at(k.requests[3]), at(k.requests[2]), 'at its earliest place');
  assert.ok(k.requests[3].messages.some((/** @type {any} */ m) => m.parts.some((/** @type {any} */ p) => p.text === '[photo /trip/files/menu.webp, the same as above]')));
});

test('the housekeeping measure weighs what is sent: an older photo left out makes no summary forced', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const done = { toolCalls: [{ name: 'speak', input: { text: 'Got it.' } }, { name: 'sleep', input: {} }] };
  /** @type {any[]} */
  const timers = [];
  const k = await agentKit([[done, done, done, done]], { agent: { timers: { set: (/** @type {any} */ fn) => { timers.push(fn); return timers.length; }, clear: (/** @type {number} */ h) => { timers[h - 1] = null; } } } });
  // The largest request at 1 MiB: two turns on, the first photo (400 KB as sent) and the new one (800 KB) together would be over it.
  await updateAppSettings(k.ws, { shiori: { compaction: { maxRequestMiB: 1 } }, photos: { request: { maxBytes: 1024 * 1024 } } });
  await k.ws.write(k.trip, '/files/a.webp', new TextEncoder().encode('x'.repeat(300_000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  await k.ws.write(k.trip, '/files/b.webp', new TextEncoder().encode('x'.repeat(600_000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (const [words, photos] of /** @type {[string, any[]][]} */ ([['Look', [{ path: '/trip/files/a.webp' }]], ['Nice', []], ['And?', []], ['This one', [{ path: '/trip/files/b.webp' }]]])) {
    k.agent.send(words, { photos });
    await k.agent.idle();
  }
  assert.equal(k.requests.length, 4);
  assert.deepEqual(await k.events(['compaction']), [], 'no summary was forced');
  assert.deepEqual(k.requests[3].messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'image').map((/** @type {any} */ p) => p.data.length), [800_000]);
});
