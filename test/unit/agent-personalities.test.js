import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { syncPersonalities, keepMine, resetPersonality, undoTuning, PERSONALITY_MAX } from '../../src/core/agent/personalities.js';
import { readAppSettings, updateAppSettings } from '../../src/core/settings.js';
import { ME } from '../../src/core/scopes.js';

const tune = (/** @type {string} */ text, /** @type {string} */ reason) => ({ toolCalls: [{ name: 'tune_personality', input: { text, reason } }, { name: 'sleep', input: {} }] });
const review = (/** @type {boolean} */ approve, /** @type {string} */ why) => ({ toolCalls: [{ name: 'review', input: { approve, why } }] });
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };

test('presets: installed once; an unedited copy follows a new original; an edited one is offered once (spec §14.1)', async () => {
  const k = await agentKit([[sleep]]);
  assert.deepEqual(await syncPersonalities({ ws: k.ws, presets: k.presets }), []);
  assert.equal(await k.ws.readText(ME, '/personalities/quiet.md'), k.presets.quiet);
  const v2 = { ...k.presets, quiet: `${k.presets.quiet}- New rule.\n`, shiori: `${k.presets.shiori}- Another.\n` };
  await k.ws.write(ME, '/personalities/shiori.md', '# Shiori\nMine now.\n', { author: 'user' });
  const offered = await syncPersonalities({ ws: k.ws, presets: v2 });
  assert.equal(await k.ws.readText(ME, '/personalities/quiet.md'), v2.quiet);
  assert.deepEqual(offered.map((o) => o.name), ['shiori']);
  assert.deepEqual(await syncPersonalities({ ws: k.ws, presets: v2 }), []);
  await keepMine(k.ws, 'shiori', v2.shiori);
  assert.equal(await k.ws.readText(ME, '/personalities/shiori.md'), '# Shiori\nMine now.\n');
  await resetPersonality(k.ws, 'shiori', v2);
  assert.equal(await k.ws.readText(ME, '/personalities/shiori.md'), v2.shiori);
});

test('tune_personality: reviewed, applied at the next wake (never mid-conversation), with a card that undoes it', async () => {
  const tuneOnly = { toolCalls: [{ name: 'tune_personality', input: { text: '# Shiori\nShorter while driving.\n', reason: 'shorter answers while driving' } }] };
  const k = await agentKit([[tuneOnly, sleep, sleep]], { utility: [review(true, 'Behaviour only.')] });
  await syncPersonalities({ ws: k.ws, presets: k.presets });
  k.agent.send('Please be shorter while I drive');
  await k.agent.idle();
  assert.equal(await k.ws.readText(ME, '/personalities/shiori.md'), '# Shiori\nShorter while driving.\n');
  // The same wake goes on with the personality it started with.
  const main = k.requests.filter((r) => r.tools?.some((/** @type {any} */ t) => t.name === 'speak'));
  assert.equal(main.length, 2);
  assert.doesNotMatch(main[1].system, /Shorter while driving/);
  k.agent.send('Thanks');
  await k.agent.idle();
  assert.match(k.requests.filter((r) => r.tools?.some((/** @type {any} */ t) => t.name === 'speak')).at(-1).system, /Shorter while driving/);
  const card = (await k.events(['out.show'])).find((e) => e.data.tune);
  assert.equal(card.data.card.text, 'shorter answers while driving');
  assert.equal((await k.events(['tool.result'])).find((e) => e.data.name === 'tune_personality').data.content, 'Approved. It applies at your next wake.');
  await undoTuning(k.ws, card.data.tune.name, card.data.tune.old);
  assert.equal(await k.ws.readText(ME, '/personalities/shiori.md'), k.presets.shiori);
});

test('a change the review turns down is not made, and Shiori is told why', async () => {
  const k = await agentKit([[tune('# Shiori\nThe user is vegetarian.\n', 'remember food'), sleep]], { utility: [review(false, 'A fact about the user belongs in memory.')] });
  await syncPersonalities({ ws: k.ws, presets: k.presets });
  k.agent.send('I am vegetarian');
  await k.agent.idle();
  assert.equal(await k.ws.readText(ME, '/personalities/shiori.md'), k.presets.shiori);
  assert.equal((await k.events(['tool.result'])).find((e) => e.data.name === 'tune_personality').data.content, 'Not changed: A fact about the user belongs in memory.');
});

test('"Ask me before Shiori changes her personality": a card asks; agreeing applies it', async () => {
  const k = await agentKit([[tune('# Shiori\nMore stories.\n', 'more stories'), sleep]], { utility: [review(true, 'Fine.')] });
  await syncPersonalities({ ws: k.ws, presets: k.presets });
  await updateAppSettings(k.ws, { shiori: { askBeforeTuning: true } });
  k.agent.send('Tell more stories');
  await k.agent.idle();
  assert.equal(await k.ws.readText(ME, '/personalities/shiori.md'), k.presets.shiori);
  const ask = k.notices.find((n) => n.title === 'Shiori wants to adjust her personality');
  await ask.actions.find((/** @type {any} */ a) => a.label === 'Agree').run();
  assert.equal(await k.ws.readText(ME, '/personalities/shiori.md'), '# Shiori\nMore stories.\n');
});

test('a personality that is too long is turned down without a review', async () => {
  const k = await agentKit([[tune(`# Shiori\n${'x'.repeat(PERSONALITY_MAX)}`, 'everything'), sleep]]);
  await syncPersonalities({ ws: k.ws, presets: k.presets });
  k.agent.send('Go');
  await k.agent.idle();
  assert.match((await k.events(['tool.result'])).find((e) => e.data.name === 'tune_personality').data.content, /too long/);
  assert.deepEqual(Object.keys((await readAppSettings(k.ws)).personalities ?? {}).sort(), ['quiet', 'shiori', 'storyteller']);
});
