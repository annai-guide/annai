import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { fakeSensors, at, iso, off, LA, NEPENTHE } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { watchTools } from '../../src/core/live/watch-tools.js';
import { readWatches } from '../../src/core/live/watches.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { logEvent } from '../../src/core/events.js';

const sleep = { name: 'sleep', input: {} };
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, sleep] });
const NEP = { id: 'nepenthe', title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, end: { at: iso('13:15'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };

/**
 * agentKit with live mode's engine on a manual clock at 08:30, the Time tools, and the now block's place.
 * @param {any[][]} scripts @param {Parameters<typeof agentKit>[1]} [o]
 */
async function liveAgent(scripts, o = {}) {
  const clock = new ManualClock(at('08:30'));
  const k = await agentKit(scripts, { ...o, agent: { now: clock.now, timeZone: () => LA, ...(o.agent ?? {}) } });
  const sensors = fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA });
  k.agent.addLoopTools(watchTools(live));
  k.agent.sense = () => live.nowInfo();
  await live.start();
  const settle = async () => {
    let before;
    do {
      before = k.requests.length;
      await live.settled();
      await k.agent.idle();
      await live.settled();
    } while (k.requests.length !== before);
  };
  await settle();
  return { ...k, clock, sensors, live, settle, to: (/** @type {number} */ t) => clock.advanceTo(t, settle) };
}

test('a watch fires and Shiori answers: she is told why, and annai shows no reminder of its own', async () => {
  const k = await liveAgent([[say('Tea time, as you asked.')]]);
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.to(at('10:00'));
  assert.equal(k.requests.length, 1);
  assert.match(k.requests[0].tail, new RegExp(`woke for: Your watch ${w.id} \\(at [^)]+\\) fired: the time came`));
  assert.deepEqual((await k.events(['wake']))[0].data.reasons.map((/** @type {any} */ r) => r.kind), ['trigger']);
  assert.deepEqual(await k.events(['reminder']), []);
  assert.deepEqual(k.notices, []);
});

test("no model can be reached: annai shows the watch's reminder, says it with voice on, and Shiori hears of it later (spec §11.3)", async () => {
  const k = await liveAgent([[{ error: 'credit', status: 402 }]], { voice: { mode: 'on' } });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.to(at('10:00'));
  await until(() => k.said.includes('Tea time.'));
  const [r] = await k.events(['reminder']);
  assert.equal(r.data.text, 'Tea time.');
  assert.equal(r.data.aloud, true);
  assert.deepEqual(k.notices.map((/** @type {any} */ n) => n.title), ["Shiori can't reach her model", 'Reminder']);
  assert.equal(k.notices[1].body, 'Tea time.');
  const t = await Transcript.load(k.store, k.trip);
  assert.ok(JSON.stringify(t.messages).includes(`[annai] Shown and said aloud by annai itself, since you couldn't be reached: \\"Tea time.\\"`));
  assert.equal(t.unanswered, false); // a reminder isn't something for her to answer at the next start
});

test('a reminder that comes while another is being said is said after it, not dropped', async () => {
  const k = await liveAgent([[{ error: 'credit', status: 402 }]], { voice: { mode: 'on', playMs: 50 } });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:01') }, fallback: 'Then cake.' });
  await k.to(at('10:01'));
  await until(() => k.said.includes('Then cake.'));
  assert.deepEqual((await k.events(['reminder'])).map((e) => [e.data.text, e.data.aloud]), [['Tea time.', true], ['Then cake.', true]]);
});

test('with no model set at all, the reminder still comes (spec §17 rule 2)', async () => {
  const k = await liveAgent([]);
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
  await k.to(at('10:00'));
  assert.deepEqual((await k.events(['reminder'])).map((e) => e.data.text), ['Tea time.']);
  assert.ok(k.notices.some((/** @type {any} */ n) => n.title === 'Reminder'));
});

test('a trigger wake the hourly limit drops still reminds; quiet hours hold Shiori, not the reminder; turning live mode on is the user’s own tap (spec §6.6)', async () => {
  const k = await liveAgent([[say('Hi.')]]);
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'One.' });
  await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:01') }, fallback: 'Two.' });
  await k.to(at('10:01'));
  assert.equal(k.requests.length, 1);
  assert.deepEqual((await k.events(['reminder'])).map((e) => e.data.text), ['Two.']);
  assert.ok(k.notices.some((/** @type {any} */ n) => n.title === 'Shiori skipped a wake'));
  const q = await liveAgent([[say('Hi.')]]);
  await updateAppSettings(q.ws, { shiori: { budgets: { quietHours: { from: '22:00', to: '07:00' } } } });
  await q.live.setWatch(q.trip, { when: { type: 'time', at: iso('23:00') }, fallback: 'Late call.' });
  await q.to(at('23:00'));
  assert.equal(q.requests.length, 0);
  assert.deepEqual((await q.events(['reminder'])).map((e) => e.data.text), ['Late call.']);
  await q.live.setLive(true);
  await q.settle();
  assert.equal(q.requests.length, 1);
  assert.match(q.requests[0].tail, /woke for: The user turned live mode on/);
});

test('the now block says where the user is and what they are doing (spec §6.3)', async () => {
  const k = await liveAgent([[say('Nepenthe is just ahead.')]]);
  await k.ws.write(k.trip, '/plan/nepenthe.json', NEP, { author: 'user' });
  await k.live.setLive(true);
  await k.settle();
  for (let s = 0; s <= 60; s += 5) {
    await k.to(at('11:40') + s * 1000);
    k.sensors.fix({ ...off(NEPENTHE, 0, 1500 - s * 15), accuracy: 8, speed: 15 });
    await k.settle();
  }
  k.agent.send('Where are we?');
  await k.settle();
  const tail = String(k.requests.at(-1).tail);
  assert.match(tail, /^place: near Nepenthe \(600 m\) · 36\.\d{5}, -121\.75670 \(±8 m\)$/m);
  assert.match(tail, /^activity: moving fast, about 54 km\/h$/m);
});

test('voice Auto hears "moving fast" from an activity sensor that came after voice started (spec §10.5)', async () => {
  const k = await agentKit([[say('Hi.')]], { voice: { mode: 'auto' } });
  assert.equal(k.voice.mode.on, false);
  /** @type {Set<() => void>} */
  const fns = new Set();
  let activity = 'still';
  k.registry.add('live', 'activity', { now: () => activity, onChange: (/** @type {() => void} */ fn) => { fns.add(fn); } });
  await until(() => fns.size === 1);
  activity = 'moving-fast';
  for (const fn of fns) fn();
  await until(() => k.voice.mode.on);
  assert.equal(k.voice.mode.why, 'moving');
});

test('Shiori sets, lists and cancels watches with her Time tools (spec §7.2)', async () => {
  const k = await liveAgent([[
    { toolCalls: [{ name: 'watch_set', input: { when: { type: 'moved', km: 15 }, repeat: true, fallback: 'Point Sur is ahead.' } }] },
    { toolCalls: [{ name: 'watch_list', input: {} }] },
    { toolCalls: [{ name: 'watch_cancel', input: { id: 'plan:nepenthe:leave' } }, sleep] },
  ]]);
  await k.ws.write(k.trip, '/plan/nepenthe.json', NEP, { author: 'user' });
  k.agent.send('Tell me about the road as we go.');
  await k.settle();
  const results = await k.events(['tool.result']);
  assert.match(results[0].data.content, /^Set w-\S+: after 15 km travelled, every time\. Live mode is off, so it waits until the user turns it on\. Now: /);
  assert.match(results[1].data.content, /^id\towner\twhen\trepeat\treminder\texpires\tlast_fired\n/);
  assert.match(results[1].data.content, /\tshiori\tafter 15 km travelled\tyes\tPoint Sur is ahead\.\t/);
  assert.match(results[1].data.content, /plan:nepenthe:leave\tsystem\t/);
  assert.equal(results[2].data.ok, false);
  assert.match(results[2].data.content, /follows the plan/);
  const { watches } = await readWatches(k.ws, k.trip);
  assert.equal(watches.length, 1);
  assert.equal((await k.ws.list(k.trip, '/watches/'))[0].author, 'shiori');
  const set = k.requests[0].tools.find((/** @type {any} */ t) => t.name === 'watch_set');
  assert.deepEqual(set.input.properties.when.properties.type.enum, ['time', 'every', 'enter', 'leave', 'dwell', 'arrived', 'moved', 'activity']);
  assert.match(set.description, /fallback \(required\)/);
  assert.ok(k.requests[0].tools.some((/** @type {any} */ t) => t.name === 'watch_list') && k.requests[0].tools.some((/** @type {any} */ t) => t.name === 'watch_cancel'));
});

test('thousands of location points never reach her context, and housekeeping does not weigh them (Review Focus 6)', async () => {
  const k = await agentKit([[say('OK.')]], { models: [{ contextWindow: 20_000 }], utility: [{ text: 'Earlier: some short exchanges.' }] });
  for (let i = 1; i <= 5; i++) {
    if (i === 5) for (let j = 0; j < 2000; j++) await logEvent(k.store, k.trip, { type: 'location', data: { lat: 36 + j / 1e5, lng: -121.9, accuracy: 8, speed: 20 } });
    k.agent.send(`Message ${i}`);
    await k.agent.idle();
  }
  const loaded = await Transcript.load(k.store, k.trip);
  assert.deepEqual(loaded.messages, k.agent.transcript.messages);
  assert.ok(!JSON.stringify(k.requests.at(-1)).includes('36.01'));
  assert.equal(await k.agent.compact('cold'), true);
  const wakes = await k.events(['wake']);
  const [c] = await k.events(['compaction']);
  assert.equal(c.data.to, wakes[1].seq - 1); // only the oldest exchange: the points weighed nothing
});

test('opening a conversation tells live mode, so it follows the open trip (spec §11)', async () => {
  const k = await agentKit([[say('Hi.')]], { open: false });
  /** @type {any[]} */
  const opened = [];
  k.agent.on('open', (o) => opened.push(o));
  await k.agent.open(k.trip);
  await k.agent.open(null);
  assert.deepEqual(opened, [{ trip: k.trip, scope: k.trip }, { trip: null, scope: 'me' }]);
});
