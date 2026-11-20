import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUES, hueOf, stepOf, litOf } from '../../src/ui/screens/trips.js';
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
    // About a tenth each (100 ± 30: three standard deviations), and two trips in a row share a hue about one time in ten (a chance of 1/10 gives
    // 100 of 1000 ± 28 at three): Knuth's hash alone gave 608 of 1000 a minute apart.
    for (const [hue, n] of seen) assert.ok(n >= 70 && n <= 130, `${apart} ms apart, hue ${hue}: ${n} of 1000`);
    assert.ok(same <= 130, `${apart} ms apart: ${same} of 1000 neighbours share a hue`);
  }
});

test("the lines' steps: none, 1-4, 5-19, 20-79, 80 and more", () => {
  const steps = [[0, 0], [1, 1], [4, 1], [5, 2], [19, 2], [20, 3], [79, 3], [80, 4], [5000, 4]];
  for (const [lines, step] of steps) assert.equal(stepOf(lines), step, `${lines} lines`);
});

test('how lit a card is by its phase: happening never under 3/4, ahead never nothing, past at half, archived and chats plain', () => {
  const by = (/** @type {any} */ phase) => [0, 1, 2, 3, 4].map((step) => litOf(phase, step));
  assert.deepEqual(by('happening'), [3 / 4, 3 / 4, 3 / 4, 3 / 4, 1]);
  assert.deepEqual(by('future'), [1 / 8, 1 / 8, 2 / 8, 3 / 8, 4 / 8]);
  assert.deepEqual(by('past'), [0, 1 / 8, 2 / 8, 3 / 8, 4 / 8]);
  assert.deepEqual(by(undefined), [0, 0, 0, 0, 0]); // archived: no row
  assert.deepEqual(by('undated'), [0, 0, 0, 0, 0]); // a chat (drawn as a line, never lit)
  // The trip of now outshines every past one, however busy.
  assert.ok(Math.min(...by('happening')) > Math.max(...by('past')));
});

test("linesSaid counts the traveller's lines, typed or heard, by the type index: a set-aside heard line counts too", async () => {
  const store = createMemoryStore();
  await store.tx(['events'], 'readwrite', async (t) => {
    const add = (/** @type {string} */ scope, /** @type {string} */ type, data = {}) => t.appendEvent(scope, { ts: 1, type, actor: type === 'heard' || type === 'msg.user' ? 'user' : 'shiori', data });
    await add('trip-a', 'msg.user');
    await add('trip-a', 'msg.user', { from: 'trip-b' }); // a hand-over's copy, as talks counts it
    await add('trip-a', 'heard');
    await add('trip-a', 'heard', { dismissed: true }); // set aside: the index can't see it (the design's call)
    await add('trip-a', 'heard.text');
    await add('trip-a', 'out.speak');
    await add('trip-a', 'location');
    await add('trip-b', 'msg.user');
  });
  assert.equal(await linesSaid(store, 'trip-a'), 4);
  assert.equal(await linesSaid(store, 'trip-b'), 1);
  assert.equal(await linesSaid(store, 'trip-c'), 0);
});
