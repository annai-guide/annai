import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { agentKit, idleAtOnce } from './agent-kit.js';
import { useClock } from './clock.js';
import { liveKit, fakeSensors, at, iso, LA } from './live-kit.js';
import { pushKit, RELAY } from './push-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { watchTools } from '../../src/core/live/watch-tools.js';
import { planWords, planned, plainReminder } from '../../src/core/live/plan-watches.js';
import { GRACE_MS, FILE } from '../../src/core/push/mirror.js';
import { SYS_DEVICE } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { wokeText, wokeTitles, errorWords } from '../../src/ui/screens/talk.js';

// watch-words-next (the Deferred entry "Shiori's own reminders keep their markdown on the card, in the voice and in the notification", 2026-11-24, from the
// user's screenshots of 2026-11-23): a reminder Shiori set reads as plain words wherever nothing is drawn (the card at the top, the voice, the phone's
// notification, the wake line, a watch's error line), from one rule (plan-watches.js plainReminder, with its one `planned` test); the conversation's line
// still draws her links, and a plan's words are annai's own, unchanged. Places, codes and addresses are made up.

const MAP = 'https://maps.example.com/?q=North%20Gate%2C%20Sample%20Park';
/** Her watch's words: a link, a bold, and a gate code whose stars must reach the traveller. */
const HERS = `Gate code *1234# at the [north gate](${MAP}). **Bring the pass.**`;
const PLAIN = 'Gate code *1234# at the north gate. Bring the pass.';
/** A plan item whose title holds what a model's Markdown would: the plan's words are annai's, shown as they are. */
const TEA = { title: 'Tea at the *old* inn', fixed: true, start: { at: iso('16:00'), tz: LA } };
const COMING = /** @type {const} */ ({ event: 'coming-up', what: { title: TEA.title, at: at('16:00'), tz: LA } });
/** What annai says for the plan's coming-up reminder, written out: the title is the plan's, stars and all (planWords makes it from COMING). */
const COMING_WORDS = 'In 15 min: Tea at the *old* inn at 16:00.';
const sleep = { name: 'sleep', input: {} };

/**
 * Reminders annai shows itself, voice on: the cards raised, the words the voice was given, what the voice said sentence by sentence (a provider voice, or
 * the phone's own), and the entries' stored words. @param {any} t @param {any[]} list @param {{ phone?: boolean }} [o]
 */
async function shown(t, list, { phone = false } = {}) {
  useClock(t);
  const k = await agentKit([[]], { voice: phone ? { speechOut: ['browser-voice'] } : {} });
  /** @type {string[]} */
  const given = [];
  /** @type {Promise<unknown>[]} */
  const saying = [];
  const say = k.voice.say.bind(k.voice);
  k.voice.say = (/** @type {string} */ words) => {
    given.push(words);
    const p = say(words);
    saying.push(p);
    return p;
  };
  await k.agent.remind(list);
  await Promise.all(saying);
  return { cards: k.notices.map((/** @type {any} */ n) => [n.title, n.body]), given, voiced: phone ? k.platform.said.map((/** @type {any} */ x) => x.text) : k.said, line: (await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text) };
}

test("her watch's words on the card and in the voice: the link by its name, no marks, the gate code's stars kept; the line keeps them as written", async (t) => {
  const s = await shown(t, [{ watch: 'w-gate', text: HERS }]);
  assert.deepEqual(s.cards, [['Reminder', PLAIN]]);
  assert.deepEqual(s.given, [PLAIN]);
  assert.deepEqual(s.voiced, ['Gate code *1234# at the north gate.', 'Bring the pass.']);
  assert.deepEqual(s.line, [HERS], 'the line draws its links from the words as written');
});

test("her watch's words in the phone's own voice: the speaker is given the plain words, the gate code's stars kept", async (t) => {
  const s = await shown(t, [{ watch: 'w-gate', text: HERS }], { phone: true });
  assert.deepEqual(s.given, [PLAIN]);
  assert.deepEqual(s.voiced, ['Gate code *1234# at the north gate.', 'Bring the pass.']);
});

test("a plan's reminder, an older plan entry and Kokoro's answer on the card and in the voice: as they were", async (t) => {
  const older = 'Leave soon for "Tea at the *old* inn" at 16:00.';
  const s = await shown(t, [
    { watch: 'plan:tea:coming-up', text: 'In 15 min: Tea at the *old* inn at 16:00.', plan: COMING },
    { watch: 'plan:tea:leave', text: older },
    { watch: '', text: HERS, answer: true },
  ]);
  assert.deepEqual(s.cards, [['Reminder', COMING_WORDS], ['Reminder', older], ["Shiori's answer", PLAIN]]);
  assert.equal(planWords(COMING), COMING_WORDS, "the plan's words keep the title as the plan has it");
  assert.deepEqual(s.given, [COMING_WORDS, older, PLAIN]);
});

test('the one rule: a plan watch is planned by its data or its id; anyone else\'s words are plain', () => {
  assert.equal(planned({ watch: 'plan:tea:leave' }), true);
  assert.equal(planned({ watch: 'w-1', plan: COMING }), true);
  assert.equal(planned({ watch: 'w-1' }), false);
  assert.equal(planned({ watch: '' }), false);
  assert.equal(plainReminder({ watch: 'w-1', text: HERS }), PLAIN);
  assert.equal(plainReminder({ watch: 'plan:tea:coming-up', text: 'x', plan: COMING }), planWords(COMING));
  assert.equal(plainReminder({ watch: 'plan:tea:leave', text: '*as* stored' }), '*as* stored');
});

test("the phone's notification says her words as plain words, as annai's card does; a plan's notification is unchanged; Koe's view keeps her words", async () => {
  const k = await pushKit({ plan: { tea: TEA }, live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: HERS });
    await k.flush();
    const list = /** @type {any[]} */ (await k.live.reminders());
    k.sensors.visible(false); // annai off screen: only the relay can say it
    await k.settle();
    await k.deliver(at('10:00') + GRACE_MS);
    assert.equal(k.pushed().at(-1).body, PLAIN);
    assert.deepEqual(list.map((m) => [m.watch, m.text, m.shown]), [[w.id, HERS, PLAIN], ['plan:tea:coming-up', COMING_WORDS, COMING_WORDS]], 'what the mirror is given: Koe\'s view keeps her words');
    await k.deliver(at('15:45') + GRACE_MS);
    const tea = k.pushed().at(-1);
    assert.deepEqual([tea.watch, tea.body, tea.what], ['plan:tea:coming-up', COMING_WORDS, 'Tea at the *old* inn at 16:00']);
  } finally {
    await k.stop();
  }
});

test("a copy at the relay from before this change, with her words as written, is called off and sent again once, as plain words; one that reads the same stays", async () => {
  const k = await pushKit({ live: false });
  try {
    // The release before this one: a time watch's item had no `shown`, so its first sync sent her words as written (the copy's hash covers them).
    const real = k.live.reminders.bind(k.live);
    k.live.reminders = async (/** @type {any} */ o) => (await real(o))?.map(({ shown: _plain, ...m }) => m) ?? null;
    await k.mirror.turnOn(RELAY);
    const gate = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: HERS });
    const tea = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('11:00') }, fallback: 'Tea time.' });
    await k.flush();
    const st = await k.ws.readJSON(SYS_DEVICE, FILE);
    const key = `${k.trip}|${gate.id}`;
    assert.equal(st.items[key].hash, createHash('sha256').update(`Big Sur\n${HERS}`).digest('hex').slice(0, 16), 'the copy that release left carries her words as written');
    const was = st.items[key].id;
    const teaWas = st.items[`${k.trip}|${tea.id}`].id;
    const from = k.net.calls.length;
    await k.reopen(); // the update: the page starts again with this code (its own Live, with its own reminders)
    await k.flush();
    const calls = k.net.calls.slice(from).filter((c) => c.method === 'DELETE' || (c.method === 'POST' && c.url.endsWith('/v1/schedule')));
    assert.deepEqual(calls.map((c) => c.method), ['DELETE', 'POST'], 'her copy called off, then sent again; nothing else');
    assert.ok(calls[0].url.endsWith(was.slice(was.indexOf('.') + 1)), 'the old copy is the one called off');
    const now = await k.ws.readJSON(SYS_DEVICE, FILE);
    assert.notEqual(now.items[key].id, was);
    assert.equal(now.items[`${k.trip}|${tea.id}`].id, teaWas, 'a copy whose words read the same stays as it was');
    assert.equal((await k.waiting()).length, 2);
    k.sensors.visible(false);
    await k.settle();
    await k.deliver(at('10:00') + GRACE_MS);
    assert.deepEqual(k.pushed().filter((p) => p.key === key).map((p) => p.body), [PLAIN], 'one notification, in plain words');
  } finally {
    await k.stop();
  }
});

test("opened from her notification: Shiori is told the plain words the phone showed; the firing's line in the same wake keeps her words as written", async () => {
  const k = await pushKit({ live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: HERS });
    await k.flush();
    k.sensors.visible(false); // annai closed: the relay's copy comes to the phone
    await k.settle();
    await k.deliver(at('10:00') + GRACE_MS);
    const body = k.pushed().at(-1).body; // what the phone showed
    k.mirror.dispose();
    k.live.dispose();
    await k.clock.advanceTo(at('10:05'));
    /** @type {import('../../src/core/live/live.js').PushNews[]} */
    const news = [{ kind: 'opened', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, title: 'Big Sur', body, t: at('10:05') }];
    const again = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: k.clock, timeZone: () => LA, news: async () => news.splice(0) });
    try {
      await again.start();
      await again.settled();
      const wake = k.agent.wakes.find((/** @type {any} */ x) => x.kind === 'catch-up');
      assert.ok(wake, 'a catch-up wake');
      assert.ok(wake.text.includes(`The user opened the reminder "${PLAIN}" from its notification at 10:05.`), wake.text);
      assert.ok(wake.text.includes(`Its reminder: "${HERS}"`), "the firing's own line keeps her words as written, so she still has the link");
    } finally {
      again.dispose();
    }
  } finally {
    await k.stop();
  }
});

test("the wake line names her watch by its words as plain words; a plan watch by its item's title, as the plan has it", async () => {
  const k = await liveKit({ plan: { tea: TEA } });
  try {
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: HERS });
    await k.to(at('10:00'));
    await k.to(at('15:45'));
    assert.deepEqual(k.agent.wakes.map((/** @type {any} */ w) => w.titles), [[PLAIN], [TEA.title]]);
    const reasons = k.agent.wakes.map((/** @type {any} */ w) => ({ kind: 'trigger', text: w.text, titles: w.titles }));
    assert.deepEqual(wokeTitles(reasons), ['Gate code *1234# at the north gate. Bring the pass', TEA.title]);
    assert.equal(wokeText(reasons.slice(0, 1)), 'Shiori woke for a reminder, or something she watches for: Gate code *1234# at the north gate. Bring the pass.');
  } finally {
    k.live.dispose();
  }
});

/** The real Agent with live mode on a manual clock (08:30), whose model only sleeps: the watches Live fires reach it as wakes. */
async function sleepyKit() {
  const clock = new ManualClock(at('08:30'));
  const k = await agentKit([[{ toolCalls: [sleep] }]], { agent: { now: clock.now, timeZone: () => LA } });
  fakeSensors(k.registry);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA });
  k.agent.addLoopTools(watchTools(live));
  await live.start();
  const settle = async () => {
    await live.settled();
    await idleAtOnce(k);
    await live.settled();
  };
  await settle();
  return { k, live, clock, settle };
}

test("a watch fires and Shiori only sleeps: annai's card is plain words, its entry keeps her words, and the wake's entry names it in plain words", async () => {
  const { k, live, clock, settle } = await sleepyKit();
  try {
    await live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: HERS });
    await clock.advanceTo(at('10:00'), settle);
    await settle();
    assert.deepEqual(k.notices.filter((/** @type {any} */ n) => n.title === 'Reminder').map((/** @type {any} */ n) => n.body), [PLAIN]);
    assert.deepEqual((await k.events(['reminder'])).map((/** @type {any} */ e) => e.data.text), [HERS]);
    const reasons = (await k.events(['wake']))[0].data.reasons;
    assert.deepEqual(reasons.map((/** @type {any} */ r) => [r.kind, r.titles]), [['trigger', [PLAIN]]]);
    assert.match(wokeText(reasons), /: Gate code \*1234# at the north gate\. Bring the pass\.$/);
  } finally {
    live.dispose();
  }
});

test("a watch the hour's limit skipped: the card that says so names it in plain words", async () => {
  const { k, live, clock, settle } = await sleepyKit();
  try {
    await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
    await live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    await live.setWatch(k.trip, { when: { type: 'time', at: iso('10:10') }, fallback: HERS });
    await clock.advanceTo(at('10:00'), settle);
    await clock.advanceTo(at('10:10'), settle);
    await settle();
    assert.deepEqual(k.notices.filter((/** @type {any} */ n) => n.title === 'Reminder').map((/** @type {any} */ n) => n.body), ['Tea time.', PLAIN], 'annai says each reminder itself, the skipped wake\'s too');
    assert.deepEqual(k.notices.filter((/** @type {any} */ n) => n.title === 'Shiori skipped a wake').map((/** @type {any} */ n) => n.body), ['A reminder, or something she watches for, woke her more than the 1 time an hour you allow: Gate code *1234# at the north gate. Bring the pass.']);
  } finally {
    live.dispose();
  }
});

test("a watch that can't be checked is named by her words' first sentence as plain words; a plan watch's line is unchanged", () => {
  const line = String(errorWords({ kind: 'trigger', type: 'place', watch: 'w-gate', reminder: HERS, why: 'its place is not a place', message: 'x' }));
  assert.equal(line, 'The watch for "Gate code *1234# at the north gate" can\'t be checked: its place is not a place.');
  assert.equal(errorWords({ kind: 'trigger', type: 'plan', watch: 'plan:tea:leave', title: TEA.title, why: 'x', message: 'x' }), 'The watch for "Tea at the *old* inn" can\'t be checked: x.');
  assert.equal(errorWords({ kind: 'trigger', type: 'plan', watch: 'plan:tea:leave', reminder: 'Leave soon: [Tea](https://x.example.com) at 16:00.', why: 'x', message: 'x' }), null, 'an older plan entry: shown as stored');
});
