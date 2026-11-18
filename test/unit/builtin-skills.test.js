import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadBuiltinSkills, BUILT_IN } from '../../src/plugins/skills/index.js';

const read = async (/** @type {string} */ p) => readFile(new URL(`../..${p}`, import.meta.url), 'utf8').catch(() => null);

test("Shiori's own skills are SKILL.md files in skills/, in the format third parties use (spec §19, §5.1)", async () => {
  const skills = await loadBuiltinSkills(read);
  assert.deepEqual(skills.map((s) => s.name), BUILT_IN);
  assert.deepEqual(BUILT_IN, ['driving-companion', 'replanning', 'plan-a-trip']);
  for (const s of skills) {
    assert.ok(s.description.length > 20, s.name);
    assert.doesNotMatch(s.text, /^---/);
  }
  assert.match(skills[0].text, /^# Driving companion\n/);
  assert.match(skills[1].description, /off plan or running late/);
});

test('a built-in skill that is missing is left out; the others still load', async () => {
  const skills = await loadBuiltinSkills(async (p) => (p.includes('replanning') ? null : read(p)));
  assert.deepEqual(skills.map((s) => s.name), ['driving-companion', 'plan-a-trip']);
});

test("the plan-a-trip skill's line on a plan item's kind is pinned, and each kind it names is a word of the reminders' table (a stay with no place still gets \"coming up\", so it says no leave or running-late reminder, not none)", async () => {
  const { KINDS } = await import('../../src/core/plan.js');
  const skill = (await loadBuiltinSkills(read)).find((s) => s.name === 'plan-a-trip');
  const line = skill?.text.split('\n').find((l) => l.startsWith('- kind is "flight"'));
  assert.equal(line, `- kind is "flight" for a flight, "rail" for a train, "ferry", "bus" or "coach" for those rides, and "lodging" for a stay's check-in or check-out: annai times reminders by these (a flight's leave reminder aims at the airport 2 hours early; a stay gets no leave or running-late reminder). Anything else takes a word of your own, such as "meal".`);
  for (const w of [...String(line).matchAll(/"([^"]+)"/g)].map((m) => m[1])) assert.ok(KINDS.has(w), w);
});
