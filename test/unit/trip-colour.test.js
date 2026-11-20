import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUES, STEPS, hueOf, stepOf, litOf } from '../../src/ui/screens/trips.js';
import { linesSaid } from '../../src/core/scopes.js';
import { createMemoryStore } from '../fakes/store-memory.js';

// Each trip card its own colour, lit by the traveller's lines (the trip-colour design, option A).

test("a trip's hue is one of the ten, the same for one `created` at every call", () => {
  for (const created of [0, 1, 1_763_500_000_000, 1_763_500_000_001, 2 ** 32, 2 ** 53 - 1]) {
    const hue = hueOf(created);
    assert.ok(HUES.includes(hue), `${created}: ${hue}`);
    for (let i = 0; i < 3; i++) assert.equal(hueOf(created), hue);
  }
  assert.equal(HUES.length, 10);
  assert.equal(new Set(HUES).size, 10);
});

test("a trip's hue for a given `created` never changes: a changed hash would recolour every trip on every phone", () => {
  // Values from the hash as built on this branch: a trip made at these moments keeps these hues, as does its copy, however it comes (an
  // import, a restore on a new phone) with its `created`; one entry for each of the ten hues. The last three differ between this hash and one without
  // its final `x >>> 16` fold, or with another shift there, which changes about one hue in 20,000 and which nothing else here would see.
  const expected = /** @type {[number, number][]} */ ([
    [0, 25], [1, 140], [1_763_549_000_091, 25], [1_763_535_000_065, 60], [1_763_626_000_234, 95], [1_763_570_000_130, 140], [1_763_591_000_169, 175],
    [1_763_619_000_221, 210], [1_763_507_000_013, 245], [1_763_500_000_000, 280], [1_763_563_000_117, 315], [1_763_521_000_039, 350],
    [1_763_500_036_413, 245], [1_763_500_041_969, 95], [1_763_500_050_045, 140],
  ]);
  for (const [created, hue] of expected) assert.equal(hueOf(created), hue, `created ${created}`);
  assert.deepEqual([...new Set(expected.map(([, hue]) => hue))].sort((a, b) => a - b), [...HUES]);
});

test('trips made close together, or a whole second, minute or day apart, spread over all ten hues, and neighbours share one about one time in ten', () => {
  const start = Date.parse('2026-11-19T08:00:00Z');
  for (const apart of [1, 1000, 60_000, 86_400_000]) {
    /** @type {Map<number, number>} */
    const seen = new Map();
    let same = 0;
    for (let i = 0; i < 1000; i++) {
      const hue = hueOf(start + i * apart);
      seen.set(hue, (seen.get(hue) ?? 0) + 1);
      if (hue === hueOf(start + (i + 1) * apart)) same++;
    }
    assert.equal(seen.size, 10, `${apart} ms apart: ${[...seen]}`);
    // About a tenth each (100 ± 30: about 3.2 standard deviations), and two trips in a row share a hue about one time in ten (a chance of 1/10 gives
    // 100 of 1000 ± 28 at three): Knuth's hash alone gave 608 of 1000 a minute apart.
    for (const [hue, n] of seen) assert.ok(n >= 70 && n <= 130, `${apart} ms apart, hue ${hue}: ${n} of 1000`);
    assert.ok(same <= 130, `${apart} ms apart: ${same} of 1000 neighbours share a hue`);
  }
});

test("the lines' steps: none, 1-4, 5-19, 20-79, 80 and more", () => {
  const steps = [[0, 0], [1, 1], [4, 1], [5, 2], [19, 2], [20, 3], [79, 3], [80, 4], [5000, 4]];
  for (const [lines, step] of steps) assert.equal(stepOf(lines), step, `${lines} lines`);
});

test('how lit a card is by its phase: happening never under 3/4, ahead never under 1/4, past at half, archived and chats plain', () => {
  const by = (/** @type {any} */ phase) => [0, 1, 2, 3, 4].map((step) => litOf(phase, step));
  assert.deepEqual(by('happening'), [3 / 4, 3 / 4, 3 / 4, 3 / 4, 1]);
  assert.deepEqual(by('future'), [1 / 4, 1 / 4, 1 / 4, 3 / 8, 1 / 2]);
  assert.deepEqual(by('past'), [0, 1 / 8, 2 / 8, 3 / 8, 4 / 8]);
  assert.deepEqual(by(undefined), [0, 0, 0, 0, 0]); // archived: no row
  assert.deepEqual(by('undated'), [0, 0, 0, 0, 0]); // a chat (drawn as a line, never lit)
  // The trip of now outshines every past one, however busy.
  assert.ok(Math.min(...by('happening')) > Math.max(...by('past')));
});

/** The memory store, with the reads of its log counted. @param {import('../fakes/store-memory.js').Store} store @returns {{ store: any, reads: () => number }} */
function counting(store) {
  let n = 0;
  const tx = (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {(t: any) => any} */ fn) => store.tx(stores, mode, (/** @type {any} */ t) => fn({ ...t, listEvents: (/** @type {string} */ scope, /** @type {any} */ q) => {
    n++;
    return t.listEvents(scope, q);
  } }));
  return { store: { ...store, tx }, reads: () => n };
}

/** @param {import('../fakes/store-memory.js').Store} store @param {string} scope @param {[string, number, ...any[]][]} lines [type, how many, data?] in order */
async function say(store, scope, lines) {
  await store.tx(['events'], 'readwrite', async (/** @type {any} */ t) => {
    for (const [type, count, data = {}] of lines) for (let i = 0; i < count; i++) await t.appendEvent(scope, { ts: 1, type, actor: type === 'heard' || type === 'msg.user' ? 'user' : 'shiori', data });
  });
}

test("linesSaid counts the lines the traveller said, typed or heard, as talks does: a heard line the gate set aside is not one", async () => {
  const store = createMemoryStore();
  await say(store, 'trip-a', [['msg.user', 1], ['msg.user', 1, { from: 'trip-b' }], ['heard', 1], ['heard', 1, { dismissed: true, gate: 'chatter' }], ['heard.text', 1], ['out.speak', 1], ['location', 1]]);
  await say(store, 'trip-b', [['msg.user', 1]]);
  await say(store, 'trip-d', [['heard', 3, { dismissed: true, gate: 'chatter' }]]); // only chatter: nobody talked here
  assert.equal(await linesSaid(store, 'trip-a', 80), 3); // a hand-over's copy counts, as talks has it
  assert.equal(await linesSaid(store, 'trip-b', 80), 1);
  assert.equal(await linesSaid(store, 'trip-c', 80), 0);
  assert.equal(await linesSaid(store, 'trip-d', 80), 0);
});

test('linesSaid counts up to what the top step needs in whole batches of it: a few reads, however many lines a trip has or however many were set aside', async () => {
  assert.equal(STEPS[STEPS.length - 1], 80); // the trip-colour tests below ask for it
  const store = createMemoryStore();
  await say(store, 'long', [['msg.user', 150], ['heard', 150]]);
  await say(store, 'aside-first', [['heard', 10, { dismissed: true }], ['msg.user', 100]]);
  await say(store, 'aside-between', [['msg.user', 50], ['heard', 35, { dismissed: true }], ['heard', 40]]);
  await say(store, 'nearly', [['msg.user', 50], ['heard', 29]]);
  await say(store, 'nearly-aside', [['msg.user', 50], ['heard', 40, { dismissed: true }], ['heard', 29]]);
  // 79 said, then many set aside: a batch cut to what is still wanted would be one entry, and a read for each of them.
  await say(store, 'last-one-aside', [['msg.user', 79], ['heard', 1000, { dismissed: true }]]);
  await say(store, 'last-one-late', [['msg.user', 75], ['heard', 1000, { dismissed: true }], ['heard', 10]]);
  /** @type {[string, number, number][]} scope, its count, the most reads: its entries up to the 80th said, in batches of 80, rounded up */
  const cases = [
    ['long', 80, 1], ['aside-first', 80, 2], ['aside-between', 80, 2], ['nearly', 79, 1], ['nearly-aside', 79, 2], ['none', 0, 1],
    ['last-one-aside', 79, 14], // 1079 entries: 13 whole batches and a rest
    ['last-one-late', 80, 14], // 1085 entries to the 80th said (the 5th of the last ten)
  ];
  for (const [scope, said, most] of cases) {
    const spy = counting(store);
    assert.equal(await linesSaid(spy.store, scope, 80), said, scope);
    assert.ok(spy.reads() <= most, `${scope}: ${spy.reads()} reads, at most ${most}`);
  }
  assert.equal(await linesSaid(store, 'long', 5), 5);
  assert.equal(await linesSaid(store, 'aside-first', 5), 5);
});
