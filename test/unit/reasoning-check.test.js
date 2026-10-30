import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCheck, checks, notes, reread, bindingControls, scan, BINDING_BETA } from '../../scripts/reasoning/run.mjs';
import { standIns } from '../../scripts/reasoning/stand-ins.mjs';
import { Keys } from '../../scripts/realtime/keys.mjs';

// The real check of keep-reasoning (docs/testing/reasoning-check.md), run here against the stand-ins only: no network, no key.

test('the reasoning check against the stand-ins: both providers pass every check, and the summary holds no key and no request body; the run leaves no timer behind', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'reasoning-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = pathToFileURL(`${dir}/`);
  const s = standIns();
  const key = new Keys([{ line: null, key: 'sk-stand-in-secret-0123' }]);
  /** @type {string[]} */
  const printed = [];
  const sleep = async () => {};
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const before = timers();
  const r = await runCheck({ providers: [{ provider: 'anthropic', key: () => key.key, fetch: s.fetch, sleep }, { provider: 'openrouter', key: () => key.key, fetch: s.fetch, sleep }], out, keys: [key], log: (x) => printed.push(x) });
  assert.ok(timers() <= before, 'the 240 s timer of the run is cleared once the turn is answered');
  assert.equal(r.pass, true, r.text);
  // Each provider refused exactly one request: the negative control's, with an earlier message changed.
  assert.equal(s.refused().length, 2);
  assert.deepEqual(r.results.map((x) => x.provider), ['anthropic', 'openrouter']);
  for (const x of r.results) assert.ok(x.checks.every((c) => !c.problems.length), JSON.stringify(x.checks.filter((c) => c.problems.length)));
  const summary = await readFile(new URL('summary.json', out), 'utf8');
  const text = await readFile(new URL('summary.txt', out), 'utf8');
  for (const written of [summary, text, printed.join('\n')]) {
    assert.ok(!written.includes('sk-stand-in-secret-0123'), 'no key');
    assert.ok(!/"messages"|"signature"|reasoning_details|Seaview Inn/.test(written), 'no request or reply body');
  }
  const rows = JSON.parse(summary).rows;
  // Kokoro's turn of four steps sends back one more each step.
  const kokoro = rows.filter((/** @type {any} */ x) => x.provider === 'anthropic' && x.half === 'Kokoro');
  assert.deepEqual(kokoro.slice(0, 4).map((/** @type {any} */ x) => x.natives?.sent ?? 0), [0, 1, 2, 3]);
  assert.match(text, /Thinking kept per turn/);
  // The control and the Claude-to-Claude turn are in the table, apart from the conversation.
  assert.ok(rows.some((/** @type {any} */ x) => x.phase === 'control' && x.altered && x.outcomes.join() === 'reasoning,ok'));
  assert.ok(rows.some((/** @type {any} */ x) => x.phase === 'cross' && x.stubbed && x.answeredBy === 'Claude Opus 5.5'));
  // Every OpenRouter row names the provider that served it; Anthropic's replies carried input_transformations.
  assert.ok(rows.filter((/** @type {any} */ x) => x.provider === 'openrouter').every((/** @type {any} */ x) => x.upstream === 'Anthropic'));
  assert.ok(rows.filter((/** @type {any} */ x) => x.provider === 'anthropic').every((/** @type {any} */ x) => Array.isArray(x.transformations)));
  assert.match(text, /Upstream provider per turn: .*Anthropic/);
  assert.match(text, /input_transformations came with \d+ of \d+ steps, always empty/);
  assert.match(text, /block_binding .* was sent on (\d+) of \1 steps/);
  assert.equal((await reread(out)).pass, true, 'report reads it again');
});

/** A row as the check records it; a fixture's defaults are a good run. @param {any} [over] */
const row = (over = {}) => ({ provider: 'anthropic', half: 'Kokoro', wake: 'w-1', step: 1, model: 'claude-sonnet-5-5', answeredBy: 'Claude Sonnet 5.5', first: 'Claude Sonnet 5.5', outcomes: ['ok'], bytes: 1, thinkingBytes: 0, natives: null, cacheRead: 0, cacheWrite: 100, cost: 0, signed: true, statuses: [200], phase: 'main', ...over });
/** A good run on one provider: a turn of three steps and the next turn's first step, then the control and the Claude-to-Claude turn. @param {string} [provider] */
function good(provider = 'anthropic') {
  const p = { provider };
  return [
    row({ ...p, step: 1, cacheRead: 0, cacheWrite: 100 }),
    row({ ...p, step: 2, natives: { sent: 1, changed: false }, cacheRead: 100, cacheWrite: 20 }),
    row({ ...p, step: 3, natives: { sent: 2, changed: false }, cacheRead: 120, cacheWrite: 20 }),
    row({ ...p, wake: 'w-2', step: 1, cacheRead: 100, cacheWrite: 30 }),
    row({ ...p, wake: 'w-3', step: 1, phase: 'control' }),
    row({ ...p, wake: 'w-3', step: 2, phase: 'control', altered: true, outcomes: ['reasoning', 'ok'], statuses: [400, 200], natives: null, benched: false }),
    row({ ...p, wake: 'w-4', step: 1, phase: 'cross' }),
    row({ ...p, wake: 'w-4', step: 2, phase: 'cross', stubbed: true, model: 'claude-opus-5-5', answeredBy: 'Claude Opus 5.5', outcomes: ['overloaded', 'overloaded', 'overloaded', 'ok'], statuses: [529, 529, 529, 200], natives: { sent: 1, changed: false } }),
  ];
}
/** The problems of each check, by the check's first words. @param {any[]} rows */
const problems = (rows) => Object.fromEntries(checks(rows).map((c) => [c.name.slice(0, 24), c.problems]));

test('a good run passes every check', () => {
  for (const provider of ['anthropic', 'openrouter']) assert.ok(checks(good(provider)).every((c) => !c.problems.length), provider);
});

test('no natives, no pass: a run in which Claude never thought, or no thinking went back, fails even when every other check holds', () => {
  const vacuous = good().map((r) => (r.phase === 'main' ? { ...r, signed: false, natives: null } : r));
  const found = checks(vacuous);
  assert.equal(found[0].problems.length, 1);
  assert.match(found[0].problems[0], /no request on a step 2 or later sent a native/);
  // The same run read as the reviewer's: only the system prompt's entry was ever read.
  const system = [1, 2, 3].map((step) => row({ step, signed: false, cacheRead: 9000, cacheWrite: 10 }));
  assert.ok(checks(system).some((c) => c.problems.length && /reads at least/.test(c.name)), 'a read of 9000 is not what 9010 cached');
});

test('the cache checks hold a step to what the one before it read and wrote, and a half\'s next turn to its last turn\'s first step', () => {
  const low = good().map((r) => (r.phase === 'main' && r.step === 3 && r.wake === 'w-1' ? { ...r, cacheRead: 119 } : r));
  const found = problems(low);
  const key = Object.keys(found).find((k) => /^within a turn/.test(k)) ?? '';
  assert.equal(found[key].length, 1);
  assert.match(found[key][0], /step 3: read 119, but step 2 had read 100 and written 20/);
  const next = good().map((r) => (r.wake === 'w-2' ? { ...r, cacheRead: 99 } : r));
  assert.match(problems(next)[key][0], /next turn's first request read 99, but the turn before had read 0 and written 100/);
  // A read of any size above zero is no longer enough.
  const small = good().map((r) => (r.wake === 'w-1' && r.step === 2 ? { ...r, cacheRead: 5 } : r));
  assert.ok(problems(small)[key].length >= 1);
});

test("Anthropic's input_transformations: a thinking block dropped for a prefix mismatch fails; another reason, or an empty list, does not", () => {
  const key = (/** @type {any[]} */ rows) => checks(rows).find((c) => /input_transformations/.test(c.name));
  assert.deepEqual(key(good())?.problems, []);
  const dropped = good().map((r, i) => (i === 2 ? { ...r, transformations: ['thinking_dropped:prefix_binding_mismatch'] } : r));
  assert.equal(key(dropped)?.problems.length, 1);
  const other = good().map((r, i) => (i === 2 ? { ...r, transformations: ['thinking_dropped:model_cannot_read'] } : r));
  assert.deepEqual(key(other)?.problems, []);
  assert.equal(checks(good('openrouter')).some((c) => /input_transformations/.test(c.name)), false, 'not asked of OpenRouter');
  assert.match(notes(good().map((r) => ({ ...r, transformations: null }))).join('\n'), /input_transformations never appeared in a stream/);
});

test('the negative control on Anthropic must be refused, asked again once on the same model, and answered, with nothing resting; on OpenRouter it is only reported', () => {
  const control = (/** @type {any} */ over, provider = 'anthropic') => good(provider).map((r) => (r.altered ? { ...r, ...over } : r));
  const find = (/** @type {any[]} */ rows) => checks(rows).find((c) => /negative control/.test(c.name))?.problems ?? [];
  assert.deepEqual(find(good()), []);
  assert.equal(find(control({ outcomes: ['ok'], statuses: [200] })).length, 2, 'answered with no refusal: the binding is not enforced');
  assert.match(find(control({ benched: true })).join(), /left resting/);
  assert.match(find(control({ answeredBy: 'Claude Opus 5.5' })).join(), /not the model asked/);
  assert.match(find(good().filter((r) => !r.altered)).join(), /no request carried thinking/);
  assert.equal(checks(control({ outcomes: ['ok'], statuses: [200] }, 'openrouter')).some((c) => c.problems.length), false);
  assert.match(notes(control({ outcomes: ['ok'], statuses: [200] }, 'openrouter')).join('\n'), /OpenRouter answered it \(200\)/);
  assert.match(notes(good('openrouter')).join('\n'), /OpenRouter refused the changed message/);
});

test('Claude to Claude: the stubbed step must be answered by the next Claude and the rest of the turn accepted; thinking stopped by differing tools is reported, not failed', () => {
  const cross = (/** @type {(r: any) => any} */ f, provider = 'anthropic') => good(provider).map((r) => (r.phase === 'cross' ? f(r) : r));
  const find = (/** @type {any[]} */ rows) => checks(rows).find((c) => /Claude to Claude/.test(c.name))?.problems ?? [];
  assert.deepEqual(find(good()), []);
  assert.match(find(cross((r) => (r.stubbed ? { ...r, model: 'claude-sonnet-5-5', outcomes: ['ok'] } : r))).join(), /not answered by the next Claude/);
  assert.match(find(cross((r) => (r.stubbed ? { ...r, outcomes: ['overloaded', 'reasoning', 'ok'] } : r))).join(), /refused for its reasoning/);
  assert.match(find(cross((r) => (r.stubbed ? { ...r, statuses: [529, 400, 200] } : r))).join(), /a 400/);
  assert.match(find(good().filter((r) => !r.stubbed)).join(), /none was made to fail/);
  const stopped = cross((r) => (r.stubbed ? { ...r, natives: { sent: 0, changed: true } } : r));
  assert.deepEqual(find(stopped), []);
  assert.match(notes(stopped).join('\n'), /thinking stopped because something before it differed between the two models/);
});

test("the check's fetch wrapper asks Anthropic for the binding controls: the beta merged into any other, block_binding only on adaptive thinking (or none set), between_tools left alone", () => {
  const set = (/** @type {any} */ thinking, headers = {}) => { const body = thinking === undefined ? {} : { thinking }; return { body, ...bindingControls(headers, body) }; };
  const unset = set(undefined, { 'x-api-key': 'k' });
  assert.deepEqual(unset.body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } });
  assert.equal(unset.bound, true);
  assert.equal(unset.headers['anthropic-beta'], BINDING_BETA);
  assert.equal(unset.headers['x-api-key'], 'k');
  const adaptive = set({ type: 'adaptive', display: 'omitted' }, { 'Anthropic-Beta': 'files-api-2025-04-14' });
  assert.deepEqual(adaptive.body.thinking, { type: 'adaptive', display: 'omitted', block_binding: { prefix_mismatch_behavior: 'error' } });
  assert.equal(adaptive.headers['Anthropic-Beta'], `files-api-2025-04-14,${BINDING_BETA}`);
  const between = set({ type: 'between_tools' });
  assert.deepEqual(between.body.thinking, { type: 'between_tools' });
  assert.equal(between.bound, false);
  assert.equal(between.headers['anthropic-beta'], BINDING_BETA, 'the header alone is harmless');
});

test("scan reads OpenRouter's provider and Anthropic's input_transformations from a stream, in plain words", () => {
  const stream = (/** @type {any[]} */ events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  assert.deepEqual(scan(stream([{ provider: 'Anthropic', choices: [] }, { provider: 'Amazon Bedrock', choices: [] }])), { upstream: 'Anthropic', transformations: null });
  assert.deepEqual(scan(stream([{ type: 'message_start', message: { input_transformations: [] } }])), { upstream: null, transformations: [] });
  assert.deepEqual(scan(stream([{ type: 'message_start', message: { input_transformations: [{ type: 'thinking_dropped', reason: 'prefix_binding_mismatch', message_index: 1 }] } }])).transformations, ['thinking_dropped:prefix_binding_mismatch']);
  assert.deepEqual(scan(stream([{ input_transformations: [{ type: 'a b\n"c"', reason: 'x'.repeat(100) }] }])).transformations?.map((x) => x.length <= 125 && !/[\n"]/.test(x)), [true]);
  assert.deepEqual(scan('not an event'), { upstream: null, transformations: null });
});
