import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveBigSur } from './big-sur-kit.js';
import { writeRecap, RECAP_SYSTEM } from '../../src/core/after/recap.js';
import { readJourney } from '../../src/core/after/journey.js';

const RECAP = '# Big Sur on Highway 1\n\n## Friday, November 27\n\nFrom Monterey down the coast to Cambria.\n\n## Highlights\n\n- Lunch at Nepenthe';

test('the Big Sur drive, simulated through live mode and Shiori, is recapped by the scripted model into /trip/recap.md (spec §20, milestone 7)', async () => {
  const { k } = await driveBigSur({ utility: [{ text: RECAP }] });
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  // The five plan places the drive arrived at earned stamps; the stops off the plan, with no offline pack, didn't.
  assert.deepEqual(j.stamps.map((s) => s.name), ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']);
  const stays = j.entries.filter((e) => e.kind === 'stay').map((e) => /** @type {any} */ (e).name);
  for (const n of ['Bixby Creek Bridge', 'Nepenthe', 'McWay Falls', 'Hearst Castle', 'Cambria Pines Lodge']) assert.ok(stays.includes(n), stays.join(', '));
  assert.ok(stays.includes(null), 'the River Inn, Ragged Point and the pier are stays without a name');
  assert.ok(j.entries.some((e) => e.kind === 'move' && e.gap), 'the phone was locked from 15:18 to 16:05');
  assert.deepEqual(j.days, ['2026-11-27']);

  await writeRecap({ store: k.store, ws: k.ws, llm: k.llm, trip: k.trip });
  assert.equal(await k.ws.readText(k.trip, '/recap.md'), `${RECAP}\n`);
  const asked = k.requests.at(-1);
  assert.equal(asked.system, RECAP_SYSTEM);
  const text = asked.messages[0].parts[0].text;
  assert.match(text, /stayed\tNepenthe/);
  assert.match(text, /worked out from \d{4} location points/);
  assert.ok(text.length < 20_000, String(text.length)); // the day in words, not its thousands of points
});
