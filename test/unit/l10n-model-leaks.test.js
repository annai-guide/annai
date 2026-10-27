import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';
import { liveKit, at, iso, LA } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { agentKit, until } from './agent-kit.js';
import { useClock } from './clock.js';
import { updateAppSettings } from '../../src/core/settings.js';

// What reaches a model stays annai's English under Japanese screens (the L5f review's probes, made tests): the next plan reminder
// in Koe's view, an opened notification in Shiori's catch-up, and why the microphone stopped while she listened.

setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));

const TEA = { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } };
const KANA = /[぀-ヿ一-鿿]/;

test("a plan reminder live mode lists: English for Koe's view (text), the screens' words for the push (shown)", async () => {
  const k = await liveKit({ plan: { tea: TEA } });
  const r = (await k.live.reminders())?.find((x) => x.watch === 'plan:tea:coming-up');
  assert.equal(r?.text, 'In 15 min: Tea at the inn at 16:00.');
  assert.equal(r?.shown, 'あと15分：Tea at the inn（16:00）。');
  k.live.dispose();
});

test("a plan reminder opened from its notification: Shiori's catch-up quotes its English, never the notification's words", async () => {
  const k = await liveKit({ live: false, plan: { tea: TEA } });
  const r = (await k.live.reminders())?.find((x) => x.watch === 'plan:tea:coming-up');
  k.live.dispose();
  await k.clock.advanceTo(at('15:50'));
  const news = [{ kind: 'opened', key: r?.key, scope: k.trip, watch: r?.watch, title: 'Big Sur', body: 'あと10分：Tea at the inn（16:00）。', t: at('15:50') }];
  const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA, news: async () => /** @type {any} */ (news.splice(0)) });
  await again.start();
  await again.settled();
  const woke = k.agent.wakes.map((/** @type {any} */ w) => w.text).join('\n');
  assert.match(woke, /opened the reminder "In 15 min: Tea at the inn at 16:00\."/);
  assert.doesNotMatch(woke, KANA);
  again.dispose();
});

test('the microphone stops while speak listens: the card in Japanese, the tool result in English', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: { dictation: true, speechIn: ['dictation', 'm-hear'], micFails: 'NotAllowedError' } });
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'listening');
  k.platform.dictation.fail('network');
  await k.agent.idle();
  const [speak] = (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === 'speak');
  assert.doesNotMatch(String(speak?.data.content), KANA);
  assert.ok(k.notices.some((/** @type {any} */ n) => KANA.test(n.title)), JSON.stringify(k.notices.map((/** @type {any} */ n) => n.title)));
});

test("a wake skipped for the hour's limit: its card says what woke her from the wake's data, never the model's English reason", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]]);
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.' });
  await k.agent.idle();
  k.agent.wake({ kind: 'trigger', text: 'Your watch w1 (at 15:00) fired: the time came. Its reminder: "Tea"', titles: ['お茶の時間'] });
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide now.' });
  await k.agent.idle();
  await until(() => k.notices.length >= 2);
  const bodies = k.notices.filter((/** @type {any} */ n) => n.title === 'Shiori は起動を見送りました').map((/** @type {any} */ n) => n.body);
  assert.equal(bodies.length, 2, JSON.stringify(k.notices));
  assert.match(bodies[0], /お茶の時間/);
  assert.match(bodies[1], /tides/);
  for (const b of bodies) assert.doesNotMatch(b, /fired|Low tide/);
});
