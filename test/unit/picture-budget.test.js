import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { limitImages } from '../../src/core/agent/refusals.js';
import { Transcript, KOE_WINDOW, KOE_JUMP } from '../../src/core/agent/transcript.js';
import { KOE_TAG } from '../../src/core/agent/log.js';
import { DEFAULT_PHOTO_SETTINGS } from '../../src/core/photos.js';

// A turn's request sends the pictures of its own messages and of the turn before's; every older one is a stub she reads again at need
// (photo-budget-next). Sizes come from the code's own values: PHOTO is a photo as sent at the default cap; OLD is a literal, the 1 MiB default
// before 2026-11-21, which the code no longer has.
/** base64 of n bytes */
const base64 = (/** @type {number} */ n) => Math.ceil(n / 3) * 4;
const PHOTO = base64(DEFAULT_PHOTO_SETTINGS.request.maxBytes);
const OLD = base64(1024 * 1024);

const text = (/** @type {string} */ t) => ({ type: /** @type {const} */ ('text'), text: t });
/** @param {string} hash @param {number} size @param {Record<string, any>} [extra] */
const img = (hash, size, extra = {}) => ({ type: /** @type {const} */ ('image'), mediaType: 'image/jpeg', data: 'A'.repeat(size), hash, ...extra });
const user = (/** @type {any[]} */ ...parts) => ({ role: /** @type {const} */ ('user'), parts });
const reply = (/** @type {string} */ t) => ({ role: /** @type {const} */ ('assistant'), parts: [text(t)] });
/** What each message sends, a picture by its hash (or page), a stub by its words. @param {any[]} messages */
const shown = (messages) => messages.map((m) => m.parts.flatMap((/** @type {any} */ p) => (p.type === 'image' ? [p.page ? `page ${p.page}` : p.hash] : p.text?.startsWith('[') ? [p.text] : [])));
const say = (/** @type {string} */ words) => ({ toolCalls: [{ name: 'speak', input: { text: words } }, { name: 'sleep', input: {} }] });
const stub = (/** @type {string} */ path) => `[photo ${path}, not sent again: read it to see it]`;
/** The words of a photo the model's count left out. */
const counted = (/** @type {string} */ path) => `[photo ${path}, not sent: this model takes fewer pictures at a time; read it to see it]`;

test("the trip's case: a photo goes in its own turn and the next, whatever its size; two turns on it is a stub that names the file, and a text turn carries no photo", () => {
  const talk = (/** @type {number} */ size) => [user(text('Look'), img('menu', size, { path: '/trip/files/menu.jpg' })), reply('A menu.'), user(text('And the price?')), reply('12 euros.'), user(text('Thanks'))];
  for (const size of [OLD, PHOTO, 10]) {
    // A text turn two turns on (the previous turn began at message 2).
    assert.deepEqual(shown(limitImages(talk(size), null, 2)), [[stub('/trip/files/menu.jpg')], [], [], [], []], `${size} bytes, two turns on`);
    // The turn after the photo's (the previous turn began at it): it still goes, as the traveller asks about what she just sent.
    assert.deepEqual(shown(limitImages(talk(size), null, 0)), [['menu'], [], [], [], []], `${size} bytes, the next turn`);
  }
  // The message the window starts at goes whole; the one before it doesn't.
  const edge = [user(img('a', 10, { path: '/a.webp' })), reply('.'), user(img('b', 10, { path: '/b.webp' })), reply('.'), user(text('Hi'))];
  assert.deepEqual(shown(limitImages(edge, null, 2)), [[stub('/a.webp')], [], ['b'], [], []]);
  // The same with a photo in the message just before the start (a read's result, say): it is a stub, and the start's goes whole.
  const adjacent = [user(img('a', 10, { path: '/a.webp' })), user(img('b', 10, { path: '/b.webp' })), reply('.'), user(text('Hi'))];
  assert.deepEqual(shown(limitImages(adjacent, null, 1)), [[stub('/a.webp')], ['b'], [], []]);
});

test('three photos in one message all go in its turn and the next; a fourth, older one is a stub with the path she can read, and two turns on none goes', () => {
  const messages = [
    user(text('The station'), img('d', PHOTO, { path: '/trip/files/d.webp' })), reply('Nice.'),
    user(text('And these'), img('a', PHOTO, { path: '/trip/files/a.webp' }), img('b', PHOTO, { path: '/trip/files/b.webp' }), img('c', PHOTO, { path: '/trip/files/c.webp' })),
  ];
  assert.deepEqual(shown(limitImages(messages, null, 2)), [[stub('/trip/files/d.webp')], [], ['a', 'b', 'c']]);
  // The same in the turn after (the previous turn began at them).
  const next = [...messages, reply('Three temples.'), user(text('Which is oldest?'))];
  assert.deepEqual(shown(limitImages(next, null, 2)), [[stub('/trip/files/d.webp')], [], ['a', 'b', 'c'], [], []]);
  // Two turns on, none of them.
  const later = [...next, reply('The first.'), user(text('Thanks'))];
  assert.deepEqual(shown(limitImages(later, null, 4))[2], [stub('/trip/files/a.webp'), stub('/trip/files/b.webp'), stub('/trip/files/c.webp')]);
});

test("a picture that leaves the window changes the request only from its own place on: what comes before it is the same, byte for byte, so the provider's cache still reads up to it", () => {
  const turn = [
    user(text('The bridge'), img('A', PHOTO, { path: '/trip/files/a.webp' })), reply('Old stone.'),
    user(text('The gate'), img('B', PHOTO, { path: '/trip/files/b.webp' })), reply('Red paint.'),
    user(text('Where now?')),
  ];
  // Turn T began at message 4: the turn before began at 2, so B goes and A doesn't.
  const before = limitImages(turn, null, 2);
  assert.deepEqual(shown(before), [[stub('/trip/files/a.webp')], [], ['B'], [], []]);
  // Turn T+1 brings a new photo and begins at 6: the turn before began at 4, so B is a stub now, and C goes.
  const after = limitImages([...turn, reply('North.'), user(text('This one?'), img('C', PHOTO, { path: '/trip/files/c.webp' }))], null, 4);
  assert.deepEqual(shown(after), [[stub('/trip/files/a.webp')], [], [stub('/trip/files/b.webp')], [], [], [], ['C']]);
  const [x, y] = [JSON.stringify(before), JSON.stringify(after)];
  let i = 0;
  while (x[i] === y[i]) i++;
  const b = JSON.stringify(turn[2].parts[1]);
  assert.ok(i >= x.indexOf(b) && i < x.indexOf(b) + b.length, `the first byte that differs (${i}) is in B's own part`);
});

test("a picture read again in a turn goes at the read's own place and every copy before the window stays a stub: the request only grows at its end", () => {
  const first = [
    user(text('The bridge'), img('A', PHOTO, { path: '/trip/files/a.webp' })), reply('Old stone.'),
    user(text('The gate'), img('B', PHOTO, { path: '/trip/files/b.webp' })), reply('Red paint.'),
    user(text('Where now?')), reply('Let me look at the bridge again.'),
  ];
  // The turn began at message 4 and the one before at 2, so A is a stub. Its next step holds her read of A, at the end.
  const step1 = limitImages(first, null, 2);
  const step2 = limitImages([...first, user({ type: 'tool_result', id: 'r1', content: 'the bridge' }, img('A', PHOTO, { path: '/trip/files/a.webp' }))], null, 2);
  assert.deepEqual(shown(step2), [...shown(step1), ['A']]);
  assert.equal(JSON.stringify(step2.slice(0, step1.length)), JSON.stringify(step1), 'nothing before the read changes');
  // A picture in the window, read again: the new copy is the same as above, and nothing before it changes.
  const step3 = limitImages([...first, user({ type: 'tool_result', id: 'r1', content: 'the gate' }, img('B', PHOTO, { path: '/trip/files/b.webp' }))], null, 2);
  assert.deepEqual(shown(step3), [...shown(step1), ['[photo /trip/files/b.webp, the same as above]']]);
  assert.equal(JSON.stringify(step3.slice(0, step1.length)), JSON.stringify(step1));
});

test("the model's count comes after the window: of the pictures in it, the oldest over the count is a stub; older ones are the window's stubs, whatever the count", () => {
  const messages = [user(text('Three'), img('a', 10, { path: '/a.webp' }), img('b', 10, { path: '/b.webp' }), img('c', 10, { path: '/c.webp' }))];
  assert.deepEqual(shown(limitImages(messages, 2, 0)), [[counted('/a.webp'), 'b', 'c']]);
  assert.equal(limitImages(messages, 3, 0), messages, 'all within both: the request as it is');
  const more = [user(img('old', 10, { path: '/old.webp' })), reply('.'), ...messages];
  assert.deepEqual(shown(limitImages(more, 2, 2)), [[stub('/old.webp')], [], [counted('/a.webp'), 'b', 'c']], 'the count and the window both act');
  // A count that admits every picture there is, the older one too, doesn't bring it back: it is the window's stub.
  assert.deepEqual(shown(limitImages(more, 9, 2)), [[stub('/old.webp')], [], ['a', 'b', 'c']]);
});

test("a PDF's page pictures: before the window every page says to read the PDF again, in it they go from page 1 and the count's own stub stays for the rest", () => {
  const PAGE = 100_000;
  const pdf = user(text('[a PDF: booking.pdf] Its pages as pictures, as you can\'t read PDFs: pages 1–3 of 3.'), img('p1', PAGE, { page: 1 }), img('p2', PAGE, { page: 2 }), img('p3', PAGE, { page: 3 }));
  const messages = [pdf, reply('Your hotel.'), user(text('When is check-in?'))];
  const lead = (/** @type {any[]} */ m) => m[0].slice(1);
  const read = (/** @type {number} */ n) => `[page ${n} of the PDF above, not sent again: read the PDF to see it]`;
  assert.deepEqual(lead(shown(limitImages(messages, null, 2))), [read(1), read(2), read(3)]);
  assert.deepEqual(lead(shown(limitImages(messages, null, 0))), ['page 1', 'page 2', 'page 3']);
  assert.deepEqual(lead(shown(limitImages(messages, 2, 0))), ['page 1', 'page 2', '[page 3 of the PDF above, not sent: this model takes fewer pictures at a time]']);
  // Before the window the count says nothing: the same words, so a stub never changes as newer pictures come.
  assert.deepEqual(lead(shown(limitImages(messages, 1, 2))), [read(1), read(2), read(3)]);
});

test('a stub says what brings its picture back: the region of a part, and for a picture no file holds, the tool whose result showed it', () => {
  const crop = [user(text('This part'), img('c', 10, { path: '/trip/files/p.webp', region: [0, 0.25, 0.5, 0.75] })), reply('A sign.'), user(text('Thanks'))];
  assert.deepEqual(shown(limitImages(crop, null, 2))[0], ['[photo /trip/files/p.webp, the part [0,0.25,0.5,0.75], not sent again: read it with that region to see it]']);
  // A web page's picture, or a skill's: no file, so no path.
  const tool = [user(text('[the result] Source: https://example.org/map.png (fetched): an image.'), img('w', 10)), reply('A map.'), user(text('Thanks'))];
  assert.deepEqual(shown(limitImages(tool, null, 2))[0], ['[the result] Source: https://example.org/map.png (fetched): an image.', "[a picture from a tool's result, not sent again: read can't bring it back; call that tool again to see it]"]);
});

test("a request outside a conversation's turns (no photosFrom: a reader's, the recap's) sends every picture, as far as the count", () => {
  const messages = [user(img('a', OLD, { path: '/a.webp' }), img('b', OLD, { path: '/b.webp' }), img('c', OLD, { path: '/c.webp' }))];
  assert.equal(limitImages(messages, null), messages);
  assert.deepEqual(shown(limitImages(messages, 2))[0], [counted('/a.webp'), 'b', 'c']);
});

test("a picture the model's count leaves out says so, and how to see it: a photo, a part of one, one from a tool's result; before the window the window's words stay", () => {
  const part = { path: '/trip/files/p.webp', region: [0, 0.25, 0.5, 0.75] };
  const messages = [user(text('Four'), img('a', 10, { path: '/trip/files/a.webp' }), img('c', 10, part), img('w', 10), img('z', 10, { path: '/trip/files/z.webp' })), reply('.'), user(text('Thanks'))];
  const why = 'not sent: this model takes fewer pictures at a time';
  assert.deepEqual(shown(limitImages(messages, 1, 0))[0], [
    `[photo /trip/files/a.webp, ${why}; read it to see it]`,
    `[photo /trip/files/p.webp, the part [0,0.25,0.5,0.75], ${why}; read it with that region to see it]`,
    `[a picture from a tool's result, ${why}; call that tool again to see it]`,
    'z',
  ]);
  // Before the window the count says nothing: the same pictures have the window's words, with the same advice.
  assert.deepEqual(shown(limitImages(messages, 1, 2))[0], [
    stub('/trip/files/a.webp'),
    '[photo /trip/files/p.webp, the part [0,0.25,0.5,0.75], not sent again: read it with that region to see it]',
    "[a picture from a tool's result, not sent again: read can't bring it back; call that tool again to see it]",
    stub('/trip/files/z.webp'),
  ]);
});

/** The images a request sends, and their sizes. @param {any} r */
const images = (r) => r.messages.flatMap((/** @type {any} */ m) => m.parts).filter((/** @type {any} */ p) => p.type === 'image');
/** The first message that holds a part with these words, or a picture. @param {any} r @param {string} [words] */
const at = (r, words) => r.messages.findIndex((/** @type {any} */ m) => m.parts.some((/** @type {any} */ p) => (words ? p.text === words : p.type === 'image')));

test("the trip's case through the agent: a photo of 1 MiB goes in its own turn and the next, at every step; the turn after that sends a stub and is text-sized again; she reads it, and the picture is at the end, nothing before it changed", async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const done = { toolCalls: [{ name: 'speak', input: { text: 'Got it.' } }, { name: 'sleep', input: {} }] };
  const looksFirst = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
  const readIt = { toolCalls: [{ name: 'read', input: { path: '/trip/files/menu.webp' } }] };
  const k = await agentKit([[done, looksFirst, done, readIt, done]]);
  // A traveller's cap of 1 MiB, as every photo had before 2026-11-21: the photo goes as it is.
  await updateAppSettings(k.ws, { photos: { request: { maxBytes: 1024 * 1024 } } });
  await k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('x'.repeat(1024 * 1024 - 100)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (const [words, photos] of /** @type {[string, any[]][]} */ ([['What does it say?', [{ path: '/trip/files/menu.webp' }]], ['And the price?', []], ['Thanks', []]])) {
    k.agent.send(words, { photos });
    await k.agent.idle();
  }
  // Her turns: the photo's (one request), the next (two: she lists first), the third (two: she reads the photo first).
  const [own, next1, next2, text, read] = k.requests;
  assert.equal(k.requests.length, 5);
  const size = images(own)[0].data.length;
  assert.ok(size > PHOTO, 'a copy bigger than a photo at the default cap');
  assert.deepEqual([next1, next2].map((r) => images(r)[0]?.data.length), [size, size], 'the turn after: what she just sent, at each of its steps');
  assert.deepEqual(images(text), [], 'two turns on');
  // Text-sized again: no part but words and the calls' own, so no picture and no document rides along either.
  assert.deepEqual([...new Set(text.messages.flatMap((/** @type {any} */ m) => m.parts.map((/** @type {any} */ p) => p.type)))].sort(), ['text', 'tool_call', 'tool_result']);
  assert.equal(at(text, stub('/trip/files/menu.webp')), 0, 'the stub is where the photo was');
  assert.ok(JSON.stringify(text).length < size, 'smaller than the photo alone');
  // Her read, in the same turn: the picture is at the read's place; nothing before it has changed.
  assert.equal(images(read).length, 1);
  assert.deepEqual(read.messages.slice(0, text.messages.length), text.messages);
  assert.ok(at(read) >= text.messages.length, 'the photo is after the stub');
});

test('the housekeeping measure weighs what is sent: an older photo left out makes no summary forced', async () => {
  const { updateAppSettings } = await import('../../src/core/settings.js');
  const done = { toolCalls: [{ name: 'speak', input: { text: 'Got it.' } }, { name: 'sleep', input: {} }] };
  /** @type {any[]} */
  const timers = [];
  const k = await agentKit([[done, done, done, done]], { agent: { timers: { set: (/** @type {any} */ fn) => { timers.push(fn); return timers.length; }, clear: (/** @type {number} */ h) => { timers[h - 1] = null; } } } });
  // The largest request at 1 MiB: in the fourth turn, three turns on from the first photo's, that photo (400 KB as sent) and the new one (800 KB) together would be over it.
  await updateAppSettings(k.ws, { shiori: { compaction: { maxRequestMiB: 1 } }, photos: { request: { maxBytes: 1024 * 1024 } } });
  await k.ws.write(k.trip, '/files/a.webp', new TextEncoder().encode('x'.repeat(300_000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  await k.ws.write(k.trip, '/files/b.webp', new TextEncoder().encode('x'.repeat(600_000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (const [words, photos] of /** @type {[string, any[]][]} */ ([['Look', [{ path: '/trip/files/a.webp' }]], ['Nice', []], ['And?', []], ['This one', [{ path: '/trip/files/b.webp' }]]])) {
    k.agent.send(words, { photos });
    await k.agent.idle();
  }
  assert.equal(k.requests.length, 4);
  assert.deepEqual(await k.events(['compaction']), [], 'no summary was forced');
  assert.deepEqual(images(k.requests[3]).map((/** @type {any} */ p) => p.data.length), [800_000]);
});

test("housekeeping in the middle of a turn drops the cache mark but not the turn's window: its summary and the request after it send the turn's photo and the one before's, and an older one stays a stub", async () => {
  // Her last turn's second step is forced to tidy up first (the last prompt was past 90% of a window of 30,000 tokens): the kept part holds all three photos.
  const k = await agentKit([[say('1'), say('2'), say('3'),
    { toolCalls: [{ name: 'list', input: { path: '/trip/' } }], usage: { input: 28_000, output: 5 } },
    { text: 'Summary of 1.' },
    say('done')]], { models: [{ contextWindow: 30_000 }] });
  for (const [name, byte] of [['a', 'x'], ['b', 'y'], ['c', 'z']]) await k.ws.write(k.trip, `/files/${name}.webp`, new TextEncoder().encode(byte.repeat(3000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (const [words, photos] of /** @type {[string, any[]][]} */ ([['one', []], ['two', [{ path: '/trip/files/a.webp' }]], ['three', [{ path: '/trip/files/b.webp' }]], ['four', [{ path: '/trip/files/c.webp' }]]])) {
    k.agent.send(words, { photos });
    await k.agent.idle();
  }
  assert.equal((await k.events(['compaction'])).length, 1, 'the turn tidied up in its middle');
  const paths = (/** @type {any} */ r) => images(r).map((/** @type {any} */ p) => p.path);
  const [asked, after] = [k.requests.at(-2), k.requests.at(-1)];
  assert.match(asked.tail, /housekeeping/);
  assert.deepEqual(paths(asked), ['/trip/files/b.webp', '/trip/files/c.webp'], "the warm summary reads the turn's cache: the same window");
  assert.equal(after.cacheAt, undefined, 'the cache mark is dropped with the old prefix');
  assert.match(after.messages[0].parts[0].text, /^\[Earlier conversation, summarized/);
  assert.ok(JSON.stringify(after.messages).includes('two'), 'the kept part begins before the older photo');
  assert.deepEqual(paths(after), ['/trip/files/b.webp', '/trip/files/c.webp'], 'this turn\'s photo and the one before\'s go');
  assert.ok(JSON.stringify(after.messages).includes(stub('/trip/files/a.webp')), 'the older one is a stub she can read');
});

test("after a summary between turns the next turn has its window: the previous turn's photo goes, older ones kept word for word are stubs", async () => {
  const k = await agentKit([[say('ok')]], { utility: [{ text: 'They planned dinner.' }] });
  for (const [name, byte] of [['a', 'x'], ['c', 'y'], ['d', 'z']]) await k.ws.write(k.trip, `/files/${name}.webp`, new TextEncoder().encode(byte.repeat(3000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (const [words, photos] of /** @type {[string, any[]][]} */ ([['m0', []], ['m1', [{ path: '/trip/files/a.webp' }]], ['m2', []], ['m3', [{ path: '/trip/files/c.webp' }]], ['m4', [{ path: '/trip/files/d.webp' }]]])) {
    k.agent.send(words, { photos });
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  for (const words of ['m1', 'm3', 'm4']) assert.ok(JSON.stringify(k.agent.transcript.messages).includes(words), `the turn of ${words} is in the part kept`);
  k.agent.send('m5');
  await k.agent.idle();
  const next = k.requests.at(-1);
  assert.deepEqual(images(next).map((/** @type {any} */ p) => p.path), ['/trip/files/d.webp']);
  assert.ok(JSON.stringify(next.messages).includes(stub('/trip/files/a.webp')) && JSON.stringify(next.messages).includes(stub('/trip/files/c.webp')));
});

test("a warm summary between turns carries the window of the turn it reads: the latest turn's photo goes, an older one is a stub", async () => {
  const k = await agentKit([[say('a'), say('b'), say('c'), say('d'), { text: 'Four turns.' }]]);
  for (const name of ['a', 'c']) await k.ws.write(k.trip, `/files/${name}.webp`, new TextEncoder().encode(name.repeat(3000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (const [words, photos] of /** @type {[string, any[]][]} */ ([['m0', []], ['m1', [{ path: '/trip/files/a.webp' }]], ['m2', []], ['m3', [{ path: '/trip/files/c.webp' }]]])) {
    k.agent.send(words, { photos });
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('warm'), true);
  const asked = k.requests.at(-1);
  assert.match(asked.tail, /housekeeping/);
  assert.deepEqual(images(asked).map((/** @type {any} */ p) => p.path), ['/trip/files/c.webp']);
  assert.ok(JSON.stringify(asked.messages).includes(stub('/trip/files/a.webp')));
});

test("what Shiori sees shows the request's stubs: the next turn's window of the conversation, not every picture", async () => {
  const k = await agentKit([[say('ok')]]);
  for (const name of ['a', 'c']) await k.ws.write(k.trip, `/files/${name}.webp`, new TextEncoder().encode(name.repeat(3000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (const [words, photos] of /** @type {[string, any[]][]} */ ([['m0', [{ path: '/trip/files/a.webp' }]], ['m1', []], ['m2', [{ path: '/trip/files/c.webp' }]]])) {
    k.agent.send(words, { photos });
    await k.agent.idle();
  }
  // The next turn begins after m2's, and the one before it began at m2: c goes, a doesn't.
  const seen = await k.agent.sees();
  assert.deepEqual(images({ messages: seen.messages }).map((/** @type {any} */ p) => p.path), ['/trip/files/c.webp']);
  assert.ok(JSON.stringify(seen.messages).includes(stub('/trip/files/a.webp')));
});

test("Koe's window moving in the middle of its turn takes the turn starts with it: this turn's photo and the one before's still go, an older one doesn't", () => {
  const t = new Transcript({ half: 'koe', nonce: 'n' });
  let seq = 0;
  const line = (/** @type {string} */ words, /** @type {any[]} */ pictures = []) => t.apply({ seq: ++seq, type: 'msg.user', data: { split: true } }, { texts: { text: words }, images: pictures });
  const replyOf = (/** @type {string} */ wake) => t.apply({ seq: ++seq, type: 'model.turn', data: { tag: KOE_TAG, half: 'koe', wake, context: { from: 1, to: seq } } }, { texts: { parts: JSON.stringify([{ type: 'text', text: 'ok' }]) }, images: [] });
  const photo = (/** @type {string} */ name) => [img(name, 10, { path: `/trip/files/${name}.webp` })];
  // Sixteen exchanges: a photo in the third (it leaves with the first six), one in the ninth, and one in the last; then this turn's line, with a photo.
  for (let i = 0; i < KOE_WINDOW + KOE_JUMP - 2; i++) {
    line(`line ${i}`, i === 2 ? photo('gone') : i === 8 ? photo('mid') : i === KOE_WINDOW + KOE_JUMP - 3 ? photo('prev') : []);
    replyOf(`w${i}`);
  }
  line('line now', photo('now'));
  replyOf('w-now');
  const first = t.windowFrom('w-now');
  assert.equal(JSON.stringify(t.messages[first].parts).includes('line 15'), true, 'the turn before began at its line');
  // A line that comes while her reply is made follows it, and is the eighteenth: the window slides by six exchanges.
  line('a line that came late');
  assert.equal(JSON.stringify(t.messages).includes('gone'), false, 'the first photo left with the front of the window');
  const from = t.windowFrom('w-now');
  assert.ok(from < first, `the start moved with the messages (${first} to ${from})`);
  assert.equal(JSON.stringify(t.messages[from].parts).includes('line 15'), true, 'it is still the line that began the turn before');
  assert.deepEqual(shown(limitImages(t.messages, null, from)).flat().filter((x) => x.startsWith('[photo ') || x === 'prev' || x === 'now'), [stub('/trip/files/mid.webp'), 'prev', 'now']);
});

test("Koe's own requests carry the window too: a chat Koe that sees photos is sent a photo in its turn and the next, at each step, and a stub after", async () => {
  const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
  const k = await agentKit([[sleep]], { koe: { type: [sleep], input: ['text', 'image'] } });
  await k.ws.write(k.trip, '/files/a.webp', new TextEncoder().encode('a'.repeat(3000)), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  const turns = ['m0', 'm1', 'm2', 'm3'];
  for (const [words, photos] of /** @type {[string, any[]][]} */ ([['m0', []], ['m1', [{ path: '/trip/files/a.webp' }]], ['m2', []], ['m3', []]])) {
    k.agent.send(words, { photos });
    await k.agent.idle();
  }
  const koe = k.sent['model-koe'];
  const turnOf = (/** @type {any} */ r) => turns.findLastIndex((w) => JSON.stringify(r.messages).includes(`[typed] ${w}`));
  // What each of Koe's requests sends, by the turn it belongs to (two requests in each turn here).
  const sends = turns.map((_, t) => [...new Set(koe.filter((/** @type {any} */ r) => turnOf(r) === t).map((/** @type {any} */ r) => images(r).map((/** @type {any} */ p) => p.path).join()))]);
  assert.deepEqual(sends, [[''], ['/trip/files/a.webp'], ['/trip/files/a.webp'], ['']]);
  assert.ok(JSON.stringify(koe.at(-1).messages).includes(stub('/trip/files/a.webp')), 'the stub she can read');
});
