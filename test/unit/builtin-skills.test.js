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
