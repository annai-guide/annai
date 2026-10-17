import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { RULES, DRIVE, places } from './big-sur-kit.js';
import { LA } from './live-kit.js';
import { Live } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { watchTools } from '../../src/core/live/watch-tools.js';
import { SimRun } from '../../src/core/live/sim-run.js';
import { ME, SYS_DEVICE } from '../../src/core/scopes.js';
import { PushMirror, GRACE_MS } from '../../src/core/push/mirror.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { relayRig, fakeSource, RELAY } from './push-kit.js';

/** Today, as the device has it: the day before the Big Sur sample's simulated drive (Nov 27), so its reminders are within the relay's reach. */
const TODAY = Date.parse('2026-11-26T09:00:00-08:00');
const CAMERA = '2026-11-28T20:00:00-08:00';
const HOME = '2026-11-29T21:00:00-08:00';

test("a simulation never touches the relay: the user's real reminders keep their real times, the run's never go, and the real ones still come at their times (M6×M7)", async () => {
  const real = new ManualClock(TODAY);
  const k = await agentKit([{ rules: RULES }], { agent: { fetch: places, now: real.now, timeZone: () => LA }, voice: { mode: 'auto' } });
  await k.host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock: real, timeZone: () => LA });
  k.agent.addLoopTools(watchTools(live));
  k.agent.sense = () => live.nowInfo();
  await live.start();
  const run = new SimRun({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, live });
  const rig = await relayRig(real.now);
  const mirror = new PushMirror({ store: k.store, ws: k.ws, live, source: fakeSource(rig.service), fetch: tracedFetch(k.store, SYS_DEVICE, { tool: 'push relay' }, rig.relayFetch), clock: real });
  /** The real clock on by ms, live mode and the mirror caught up. */
  const step = async (ms = 1000) => {
    await real.advanceTo(real.now() + ms, async () => { await live.settled(); });
    await mirror.settled();
    await live.settled();
    await mirror.settled();
  };
  try {
    await mirror.start();
    await live.setWatch(k.trip, { when: { type: 'time', at: CAMERA }, fallback: 'Pack the camera batteries.' });
    await live.setWatch(ME, { when: { type: 'time', at: HOME }, fallback: 'Call home.' });
    await mirror.turnOn(RELAY);
    await step();
    const before = (await rig.env.RELAY.waiting()).map((w) => `${w.id} ${w.sendAt}`).sort();
    assert.deepEqual((await rig.env.RELAY.waiting()).map((w) => w.sendAt).sort(), [Date.parse(CAMERA) + GRACE_MS, Date.parse(HOME) + GRACE_MS]);
    const from = rig.net.calls.length;
    await run.start({ kind: 'itinerary', itinerary: DRIVE }, { speed: 'fast' });
    // While it runs, the mirror looks as often as it can.
    let done = false;
    run.finished.then(() => { done = true; });
    while (!done) {
      await mirror.sync();
      await new Promise((r) => setTimeout(r, 2));
    }
    await mirror.sync();
    for (let i = 0; i < 40; i++) await step(); // and after it, as real time goes on
    const touched = rig.net.calls.slice(from).filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url).pathname}`);
    assert.deepEqual(touched, [], 'no schedule and no cancel from the run');
    assert.deepEqual((await rig.env.RELAY.waiting()).map((w) => `${w.id} ${w.sendAt}`).sort(), before, 'the real reminders wait as they were');
    // On the real clock they come at their real times: with annai off screen, through the relay.
    live.visible(false);
    await live.settled();
    await real.advanceTo(Date.parse(CAMERA) + GRACE_MS, async () => { await live.settled(); });
    await rig.env.RELAY.runDue();
    const pushed = rig.service.received.filter((r) => r.status === 201).map((r) => JSON.parse(String(r.plaintext)));
    assert.deepEqual(pushed.filter((p) => !p.test).map((p) => p.body), ['Pack the camera batteries.']);
  } finally {
    mirror.dispose();
    live.dispose();
    await rig.service.stop();
  }
});
