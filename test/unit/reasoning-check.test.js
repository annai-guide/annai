import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCheck, checks, reread } from '../../scripts/reasoning/run.mjs';
import { standIns } from '../../scripts/reasoning/stand-ins.mjs';
import { Keys } from '../../scripts/realtime/keys.mjs';

// The real check of keep-reasoning (docs/testing/reasoning-check.md), run here against the stand-ins only: no network, no key.

test('the reasoning check against the stand-ins: both providers pass all four checks, and the summary holds no key and no request body', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'reasoning-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = pathToFileURL(`${dir}/`);
  const s = standIns();
  const key = new Keys([{ line: null, key: 'sk-stand-in-secret-0123' }]);
  /** @type {string[]} */
  const printed = [];
  const r = await runCheck({ providers: [{ provider: 'anthropic', key: () => key.key, fetch: s.fetch }, { provider: 'openrouter', key: () => key.key, fetch: s.fetch }], out, keys: [key], log: (x) => printed.push(x) });
  assert.equal(r.pass, true, r.text);
  assert.deepEqual(s.refused(), []);
  assert.deepEqual(r.results.map((x) => x.provider), ['anthropic', 'openrouter']);
  for (const x of r.results) assert.ok(x.checks.every((c) => !c.problems.length));
  const summary = await readFile(new URL('summary.json', out), 'utf8');
  const text = await readFile(new URL('summary.txt', out), 'utf8');
  for (const written of [summary, text, printed.join('\n')]) {
    assert.ok(!written.includes('sk-stand-in-secret-0123'), 'no key');
    assert.ok(!/"messages"|"signature"|reasoning_details|Seaview Inn/.test(written), 'no request or reply body');
  }
  // Kokoro's turn of four steps sends back one more each step.
  const kokoro = JSON.parse(summary).rows.filter((/** @type {any} */ x) => x.provider === 'anthropic' && x.half === 'Kokoro');
  assert.deepEqual(kokoro.slice(0, 4).map((/** @type {any} */ x) => x.natives?.sent ?? 0), [0, 1, 2, 3]);
  assert.match(text, /Thinking kept per turn/);
  assert.equal((await reread(out)).pass, true, 'report reads it again');
});

test('the checks fail a step that sent no thinking back, a refused attempt, a fallback, and a step that read no cache', () => {
  const row = (/** @type {any} */ over) => ({ provider: 'anthropic', half: 'Kokoro', wake: 'w-1', step: 1, model: 'claude-sonnet-5-5', answeredBy: 'Claude Sonnet 5.5', first: 'Claude Sonnet 5.5', outcomes: ['ok'], bytes: 1, thinkingBytes: 0, natives: null, cacheRead: 0, cacheWrite: 1, cost: 0, signed: true, statuses: [200], ...over });
  const failed = checks([
    row({}),
    row({ step: 2, natives: { sent: 0, changed: true }, cacheRead: 5, outcomes: ['reasoning', 'ok'], statuses: [400, 200] }),
    row({ step: 3, natives: { sent: 2, changed: false }, cacheRead: 0, answeredBy: 'Other', outcomes: ['ok'] }),
  ]);
  assert.deepEqual(failed.map((c) => c.problems.length), [1, 2, 2, 1]);
});
