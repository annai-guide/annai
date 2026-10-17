import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkill, frontMatter, checkSkillName, skillLinks, skillVersion, SkillError, SKILL_FILE } from '../../src/core/skills.js';

const SKILL = `---
name: tide-pools
description: When the user asks about tide pools - how to read a tide table, and when pools are safe to visit.
license: CC-BY-4.0
metadata:
  author: Example Trails
  version: "1.2"
---
# Tide pools

Check [the safety notes](references/safety.md) and ![a chart](assets/chart.png).
`;

test('a skill: name, description and metadata from the front matter, and the body after it (spec §5.1)', () => {
  const s = parseSkill(SKILL);
  assert.equal(SKILL_FILE, 'SKILL.md');
  assert.equal(s.name, 'tide-pools');
  assert.match(s.description, /^When the user asks about tide pools - how to read/);
  assert.equal(s.license, 'CC-BY-4.0');
  assert.deepEqual(s.metadata, { author: 'Example Trails', version: '1.2' });
  assert.match(s.body, /^# Tide pools\n\nCheck/);
  assert.equal(skillVersion(s.metadata), '1.2.0');
});

test('front matter as people write it: CRLF, a byte-order mark, escapes, a colon in a plain value, blocks, comments, lists', () => {
  const crlf = '﻿---\r\nname: a-b\r\ndescription: "Says \\"hi\\": a test"\r\n---\r\nBody\r\n';
  assert.deepEqual([parseSkill(crlf).description, parseSkill(crlf).body], ['Says "hi": a test', 'Body\n']);
  const s = parseSkill(`---
name: x-y
# a comment
description: >
  Folded onto
  one line.
license: 'It''s free'
compatibility: |
  Line one
  Line two
allowed-tools:
  - Read
  - Bash(git:*)
other: Tide pools: when they are safe # not part of it
---
B`);
  assert.equal(s.description, 'Folded onto one line.');
  assert.equal(s.license, "It's free");
  assert.equal(s.compatibility, 'Line one\nLine two');
  assert.equal(s.allowedTools, 'Read Bash(git:*)');
  assert.equal(frontMatter('---\nname: x\nother: Tide pools: when they are safe # not part of it\n---\n').data.other, 'Tide pools: when they are safe');
  assert.equal(parseSkill('---\nname: c-d\ndescription: A long one\n  that goes on here.\n---\n').description, 'A long one that goes on here.');
});

test('a SKILL.md annai refuses says why, in plain words', () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ['# No front matter', /starts with front matter/],
    ['---\nname: a-b\ndescription: x\n', /isn't closed/],
    ['---\ndescription: x\n---\n', /needs a name/],
    ['---\nname: a-b\n---\n', /needs a description/],
    ['---\nname: Tide_Pools\ndescription: x\n---\n', /lowercase letters, digits and dashes/],
    ['---\nname: -tides\ndescription: x\n---\n', /can't start or end with a dash/],
    ['---\nname: ti--des\ndescription: x\n---\n', /two dashes in a row/],
    [`---\nname: a-b\ndescription: ${'x'.repeat(1025)}\n---\n`, /at most 1024 characters/],
    [`---\nname: ${'a'.repeat(65)}\ndescription: x\n---\n`, /1 to 64/],
  ];
  for (const [text, why] of cases) assert.throws(() => parseSkill(text), (e) => e instanceof SkillError && why.test(/** @type {Error} */ (e).message), String(why));
  assert.equal(checkSkillName('tide-pools'), null);
  assert.match(String(checkSkillName(42)), /lowercase/);
});

test('the files a SKILL.md links to, inside its folder, each once', () => {
  const body = 'See [a](references/a.md), [again](references/a.md#part), ![img](./assets/c%20d.png "t"), [q](references/q.md?x=1), '
    + '[web](https://example.com/x), [top](#top), [abs](/etc/passwd), [up](../secret.md), [mail](mailto:x@y.z).';
  assert.deepEqual(skillLinks(body), ['references/a.md', 'assets/c d.png', 'references/q.md']);
});

test("a skill's version: digits made semantic, anything else 0.0.0", () => {
  assert.deepEqual(['2', '1.2', '1.2.3', 'v1', '1.2.3.4', undefined].map((v) => skillVersion(v === undefined ? {} : { version: v })), ['2.0.0', '1.2.0', '1.2.3', '0.0.0', '0.0.0', '0.0.0']);
});
