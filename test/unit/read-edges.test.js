import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushKit, breakReads, RELAY, at, iso, LA } from './push-kit.js';
import { liveKit } from './live-kit.js';
import { createTrip, SYS_DEVICE } from '../../src/core/scopes.js';
import { FILE } from '../../src/core/push/mirror.js';
import { RIVER_INN } from './live-kit.js';
import { record } from '../../src/core/agent/log.js';

// Fix pass 10: the seven edges review 9 found around "a read answers, or nothing changes" (F1 to F7; F7 is in the browser suite store-idb).

const ROAD = { tea: { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } } };
const PLAIN = { id: 'plain', title: 'Plain', fixed: true, start: { at: iso('18:00'), tz: LA } };

/** @param {() => Promise<void>} fn */
const quiet = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
};
/** @param {any} k @param {string} scope @param {number} t */
async function say(k, scope, t) {
  await k.to(t);
  await record(k.store, scope, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: t });
  k.agent.opened(scope);
  await k.flush();
}
const deletes = (/** @type {any} */ k) => k.net.calls.filter((/** @type {any} */ c) => c.method === 'DELETE').length;
const said = (/** @type {any} */ k) => k.agent.wakes.flatMap((/** @type {any} */ w) => (w.fallbacks ?? []).map((/** @type {any} */ f) => f.text)).concat(k.agent.reminders.map((/** @type {any} */ r) => r.text));

// F1. #changed asked `c.scope === this.#trip` outside the queue; a trip coming into play isn't #trip until its load ends.
for (const during of [false, true]) {
  test(`F1 an edit in the trip coming into play, landing ${during ? 'during' : 'after'} its load, nothing failing: Live and the phone get the new words`, () => quiet(async () => {
    const k = await pushKit({ plan: ROAD, live: false });
    try {
      const side = await createTrip(k.ws, { title: 'Side', start: '2026-11-27', end: '2026-11-28' });
      await k.ws.write(side, '/plan/plain.json', PLAIN, { author: 'user' });
      await k.mirror.turnOn(RELAY);
      await k.flush();
      await say(k, side, at('08:40'));
      await say(k, k.trip, at('09:00'));
      assert.equal(k.live.play, k.trip);
      const edit = () => k.ws.write(side, '/plan/plain.json', { ...PLAIN, title: 'Renamed' }, { author: 'user' });
      const read = k.ws.readJSON.bind(k.ws);
      let armed = during;
      let seen = false;
      // The load has read the plan file when its next read, of /trip.json, is held up by the edit.
      k.ws.readJSON = async (scope, path) => {
        if (scope === side && path === '/plan/plain.json') seen = true;
        if (armed && seen && scope === side && path === '/trip.json') { armed = false; await edit(); }
        return read(scope, path);
      };
      await say(k, side, at('09:30'));
      k.ws.readJSON = read;
      assert.equal(k.live.play, side);
      if (!during) await edit();
      assert.equal(armed, false, 'the edit landed');
      await k.flush(120_000);
      const list = (await k.live.reminders()) ?? [];
      assert.match(JSON.stringify(list.filter((r) => r.scope === side).map((r) => r.shown)), /Renamed/);
      assert.equal(deletes(k), 1, 'the old copy is called off once');
      k.sensors.visible(false);
      await k.settle();
      await k.deliver(at('17:46'));
      const words = JSON.stringify(k.pushed().filter((p) => p.scope === side).map((p) => p.what ?? p.body));
      assert.match(words, /Renamed/);
      assert.doesNotMatch(words, /Plain at/);
    } finally {
      await k.stop();
    }
  }));
}

// F3. #exists meets a failed read in #drop and #hear as it does in #fire: the trip is there.
for (const fail of [false, true]) {
  test(`F3 a time watch fires with its scope read failing=${fail}: its file goes, and it is said once`, () => quiet(async () => {
    const k = await liveKit({ live: false });
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:10') }, fallback: 'Call Mum.' });
    await k.settle();
    await k.to(at('09:09:59'));
    await k.settle();
    const b = fail ? breakReads(k, (op, key) => op === 'getScope' && key === k.trip) : null;
    await k.to(at('09:10:01'));
    await k.settle();
    b?.heal();
    assert.equal((await k.ws.list(k.trip, '/watches/')).length, 0, 'the one-time watch is gone');
    await k.to(at('09:40'));
    await k.restart();
    await k.settle();
    await k.to(at('09:45'));
    await k.settle();
    assert.deepEqual(said(k), ['Call Mum.']);
    k.live.dispose();
  }));
}

test('F3 a watch Shiori cancels as the scope read fails is cancelled: it does not come back', () => quiet(async () => {
  const k = await liveKit({ live: false });
  const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('15:00') }, fallback: 'Call Mum.' });
  await k.settle();
  const b = breakReads(k, (op, key) => op === 'getScope' && key === k.trip);
  await k.live.cancelWatch(k.trip, w.id);
  b.heal();
  assert.equal((await k.ws.list(k.trip, '/watches/')).length, 0);
  await k.restart();
  await k.settle();
  assert.equal((await k.live.listWatches(k.trip)).split('\n').length - 1, 0, 'nothing listed after a restart');
  k.live.dispose();
}));

for (const fail of [false, true]) {
  test(`F3 a notification the phone showed, heard in a catch-up with the scope read failing=${fail}: it is a double, and not said again`, () => quiet(async () => {
    /** @type {any[]} */
    const inbox = [];
    const k = await liveKit({ live: false, news: async () => inbox.splice(0) });
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    k.sensors.visible(false);
    await k.settle();
    await k.to(at('10:05'));
    inbox.push({ kind: 'shown', key: `${k.trip}|${w.id}`, scope: k.trip, watch: w.id, at: at('10:00'), t: at('10:00:30') });
    // The news is heard as annai comes back, and the catch-up runs on: the scope read fails for the news alone.
    const b = fail ? breakReads(k, (op, key) => op === 'getScope' && key === k.trip) : null;
    k.sensors.visible(true);
    await k.settle();
    b?.heal();
    assert.deepEqual(k.agent.wakes.flatMap((x) => (x.fallbacks ?? []).map((/** @type {any} */ f) => f.text)), [], 'not said again on screen');
    assert.match(k.agent.wakes.map((x) => x.text).join('\n'), /its notification was shown at 10:00/);
    k.live.dispose();
  }));
}

// F4. #loadAll set a scope's watches before its firings were read; a failed read of the firings let an `every` watch count from when it was set.
for (const where of ['me', 'a future trip']) {
  for (const fail of [false, true]) {
    test(`F4 an hourly watch in ${where} across a start, its fired log failing=${fail}: nothing fires at the start, the next is at 10:30`, () => quiet(async () => {
      const k = await liveKit({ live: false });
      const scope = where === 'me' ? 'me' : await createTrip(k.ws, { title: 'Later', start: '2026-12-20', end: '2026-12-21' });
      k.agent.opened(where === 'me' ? null : scope);
      await k.settle();
      await k.live.setWatch(scope, { when: { type: 'every', minutes: 60 }, fallback: 'Hourly stretch.' });
      await k.settle();
      await k.to(at('09:31'));
      await k.settle();
      assert.deepEqual(said(k), ['Hourly stretch.'], 'fired at 09:30');
      await k.to(at('09:40'));
      await k.settle();
      const b = fail ? breakReads(k, (op, key, o) => op === 'listEvents' && key === scope && o?.types?.[0] === 'trigger.fired') : null;
      await k.restart();
      b?.heal();
      await k.to(at('10:00'));
      await k.settle();
      assert.deepEqual(said(k), ['Hourly stretch.'], 'nothing more by 10:00');
      await k.to(at('10:31'));
      await k.settle();
      assert.deepEqual(said(k), ['Hourly stretch.', 'Hourly stretch.'], 'the next at 10:30');
      k.live.dispose();
    }));
  }
}

// F5. A read that heals itself is no card: the Trace has it (kind "read" in the device's log), once a kind for Live and once a run of failed syncs.
const readLines = async (/** @type {any} */ k) => (await k.events(['error'], SYS_DEVICE)).filter((/** @type {any} */ e) => e.data.kind === 'read');

test('F5 four minutes of a failing read: no card, one Trace line from Live and one from the stopped sync, and a new run of failures a new line', () => quiet(async () => {
  const problems = [];
  const k = await pushKit({ plan: ROAD, live: true, problem: (e) => problems.push(e) });
  try {
    const trips = [];
    for (let i = 0; i < 3; i++) {
      const id = await createTrip(k.ws, { title: `T${i}`, start: '2026-12-01', end: '2026-12-02' });
      trips.push(id);
      await k.ws.write(id, '/plan/plain.json', PLAIN, { author: 'user' });
    }
    await k.mirror.turnOn(RELAY);
    await k.flush();
    assert.deepEqual(await readLines(k), []);
    const run = async (/** @type {number} */ from) => {
      const b = breakReads(k, (op, key) => op === 'listEvents' && key === trips.at(-1));
      await k.live.tripsChanged(); // owed from now
      await k.settle();
      for (let s = 1; s <= 240; s += 1) await k.fix(from + s * 1000, RIVER_INN, { speed: 0 });
      await k.mirror.settled();
      b.heal();
      await k.flush(70_000);
      return k.clock.now();
    };
    const t1 = await run(k.clock.now());
    assert.deepEqual(problems, [], 'no card');
    const lines = await readLines(k);
    assert.equal(lines.length, 2, JSON.stringify(lines.map((e) => e.data)));
    assert.deepEqual(lines.map((e) => e.actor), ['system', 'system']);
    assert.ok(lines.every((e) => typeof e.data.message === 'string' && e.data.message.length > 0));
    // Where a Trace reader looks: an "error" entry in the device's log, which the Errors kind lists, written "read: <message>".
    const { traceSummary } = await import('../../src/ui/screens/trace.js');
    assert.match(traceSummary(lines[0]), /^read: The transaction was aborted/);
    // A sync that went through ended the run: the next failure is told again. Live's own line is once for the page.
    await run(t1);
    assert.deepEqual(problems, [], 'still no card');
    assert.equal((await readLines(k)).length, 3);
  } finally {
    await k.stop();
  }
}));

// Each read site alone: the start's follow, the start's last-seen read, and a reread (a conversation opened reads the trips' records again).
/** @type {[string, (op: string, key: string, o?: any) => boolean, (k: any) => Promise<unknown>][]} */
const SITES = [
  ['#follow, at the start', (op, _k, o) => op === 'listEvents' && o?.types?.[0] === 'trigger.fired', (k) => k.restart()],
  ['#lastSeen, at the start', (op, _k, o) => op === 'listEvents' && o?.limit === 1, (k) => k.restart()],
  ['#reread, as a conversation opens', (op) => op === 'listScopes', async (k) => { k.agent.opened(k.trip); await k.settle(); }],
];
for (const [site, fails, act] of SITES) {
  test(`F5 a failed read at ${site} is no card: one Trace line`, () => quiet(async () => {
    const problems = [];
    const k = await liveKit({ live: true, problem: (e) => problems.push(e) });
    try {
      const b = breakReads(k, fails);
      await act(k);
      b.heal();
      assert.ok(b.log.length > 0, 'the read failed');
      assert.deepEqual(problems, []);
      assert.equal((await readLines(k)).length, 1);
    } finally {
      k.live.dispose();
    }
  }));
}

// F6. turnOn is on when the hello went; the copy that follows is a sync that tries again by itself.
test('F6 turnOn whose following sync meets a failed read resolves: it is on, and the copy reaches the relay by itself', () => quiet(async () => {
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    const side = await createTrip(k.ws, { title: 'Side', start: '2026-11-27', end: '2026-11-28' });
    await k.ws.write(side, '/plan/plain.json', PLAIN, { author: 'user' });
    await k.flush();
    // Reads fail from the hello on: the sync after it is the one that stops.
    let on = false;
    const subscribe = k.source.subscribe;
    k.source.subscribe = async (key) => { const s = await subscribe(key); on = true; return s; };
    const b = breakReads(k, (op) => on && op === 'listScopes');
    await assert.doesNotReject(k.mirror.turnOn(RELAY));
    b.heal();
    assert.equal((await k.mirror.status()).on, true);
    assert.equal(k.pushed().length, 1, 'the hello');
    await k.flush(60_000);
    const st = /** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE));
    assert.ok(Object.keys(st.items).length > 0, 'a copy went to the relay by itself');
  } finally {
    await k.stop();
  }
}));

// Fix pass 11. R1: a Trace line whose write fails keeps its time and waits until it can be written.
for (const shape of ['reads only', 'reads and writes', 'writes heal 20 s before reads']) {
  test(`R1 three minutes of failing, ${shape}: the Trace gets both lines, Live's and the stopped sync's, and no card`, () => quiet(async () => {
    const problems = [];
    const k = await pushKit({ plan: ROAD, live: true, problem: (e) => problems.push(e) });
    try {
      const side = await createTrip(k.ws, { title: 'Side', start: '2026-12-01', end: '2026-12-02' });
      await k.ws.write(side, '/plan/plain.json', PLAIN, { author: 'user' });
      await k.mirror.turnOn(RELAY);
      await k.flush();
      const t0 = k.clock.now();
      const writes = (/** @type {string[]} */ _stores) => shape === 'reads and writes' || (shape !== 'reads only' && k.clock.now() < t0 + 160_000);
      const b = breakReads(k, () => true, writes);
      await k.live.tripsChanged().catch(() => {});
      await k.settle();
      for (let s = 1; s <= 180; s += 1) await k.fix(t0 + s * 1000, RIVER_INN, { speed: 0 });
      await k.mirror.settled();
      b.heal();
      await k.flush(70_000);
      assert.deepEqual(problems, [], 'no card');
      assert.equal((await readLines(k)).length, 2);
    } finally {
      await k.stop();
    }
  }));
}

// R3. The first read of start() failing: Live starts, with GPS off for that page load, and says so in the Trace.
for (const fail of [false, true]) {
  test(`R3 the settings read at Live's start failing=${fail}: Live starts, the 09:30 watch is said, ${fail ? 'one' : 'no'} Trace line`, () => quiet(async () => {
    const k = await pushKit({ plan: ROAD, live: true });
    try {
      await k.mirror.turnOn(RELAY);
      await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:30') }, fallback: 'Call Mum.' });
      await k.flush();
      let left = fail ? 1 : 0;
      const b = breakReads(k, (op, key, path) => op === 'getFile' && key === 'sys:settings' && path === '/app.json' && left-- > 0);
      await k.reopen();
      b.heal();
      assert.equal(b.log.length, fail ? 1 : 0, 'the read failed once');
      await k.to(at('09:40'));
      await k.flush(120_000);
      assert.deepEqual(said(k), ['Call Mum.']);
      assert.equal((await readLines(k)).length, fail ? 1 : 0);
    } finally {
      await k.stop();
    }
  }));
}

// R4. A watch is never looked at without its firings, by #changed either: a new reminder while the log's read still fails.
for (const fail of [false, true]) {
  test(`R4 a new reminder in Me while the firings read fails=${fail} after a start that failed it: the 60-minute watch does not fire at 09:40`, () => quiet(async () => {
    const k = await liveKit({ live: false });
    k.agent.opened(null);
    await k.settle();
    await k.live.setWatch('me', { when: { type: 'every', minutes: 60 }, fallback: 'Hourly stretch.' });
    await k.settle();
    await k.to(at('09:31'));
    await k.settle();
    assert.deepEqual(said(k), ['Hourly stretch.'], 'fired at 09:30');
    await k.to(at('09:40'));
    await k.settle();
    const b = fail ? breakReads(k, (op, key, o) => op === 'listEvents' && key === 'me' && o?.types?.[0] === 'trigger.fired') : null;
    await k.restart();
    await k.to(at('09:40:10'));
    await k.settle();
    await k.live.setWatch('me', { when: { type: 'time', at: iso('15:00') }, fallback: 'Call Mum.' });
    await k.settle();
    await k.to(at('09:41'));
    await k.settle();
    b?.heal();
    assert.deepEqual(said(k), ['Hourly stretch.']);
    await k.to(at('10:00'));
    await k.settle();
    assert.deepEqual(said(k), ['Hourly stretch.']);
    k.live.dispose();
  }));
}
