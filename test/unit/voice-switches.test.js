import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { fakeSensors, memoryKeep, at, LA, MONTEREY, off } from './live-kit.js';
import { Live, FIX_WAIT_MS } from '../../src/core/live/live.js';
import { ManualClock } from '../../src/core/live/clock.js';
import { updateAppSettings, readAppSettings } from '../../src/core/settings.js';
import { SYS_DEVICE } from '../../src/core/scopes.js';
import { nowBlock } from '../../src/core/agent/context.js';
import { voiceWhy } from '../../src/core/voice/mode.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
/** @param {() => Promise<boolean>} fn */
const eventually = async (fn, by = Date.now() + 3000) => { while (!(await fn())) { if (Date.now() > by) throw new Error('still waiting'); await tick(); } };
const STOPPED = 'Voice off: you stopped driving';
const UNPLUGGED = 'Voice off: the microphone disconnected';

/** A real Voice and a Live on a manual clock, GPS on; the notes voice left. @param {{ setting?: 'on' | 'off', kit?: any, rules?: any[], keep?: any }} [o] */
async function drive({ setting = 'off', rules = [{ match: '.', reply: sleep }], kit = {}, keep = memoryKeep() } = {}) {
  const clock = new ManualClock(at('17:00'));
  const k = await agentKit([{ rules }], { agent: { now: clock.now, timeZone: () => LA }, voice: { mode: setting }, ...kit });
  await updateAppSettings(k.ws, { live: { on: true } });
  const sensors = fakeSensors(k.registry);
  /** @type {string[]} */
  const notes = [];
  k.voice.onNote((/** @type {string} */ n) => notes.push(n));
  const start = async () => {
    const live = new Live({ store: k.store, ws: k.ws, registry: k.registry, agent: k.agent, clock, timeZone: () => LA, keep });
    await live.start();
    await live.settled();
    await tick();
    return live;
  };
  const d = {
    k, clock, sensors, notes, keep, start, live: await start(), p: MONTEREY,
    /** @param {number} t @param {number} speed */
    async fix(t, speed) {
      await clock.advanceTo(t, () => d.live.settled());
      d.p = speed > 1 ? off(d.p, 0, -speed * 5) : d.p;
      sensors.fix({ lat: d.p.lat, lng: d.p.lng, accuracy: 8, speed });
      await d.live.settled();
      await tick();
    },
    /** Speeds from t0 for secs, a fix every 5 s. @param {number} t0 @param {number} secs @param {number} speed */
    async run(t0, secs, speed) {
      for (let s = 0; s <= secs; s += 5) await d.fix(t0 + s * 1000, speed);
    },
    /** The clock runs on, with no fixes. @param {number} to */
    async wait(to) {
      for (let t = clock.now() + 10_000; t <= to; t += 10_000) {
        await clock.advanceTo(t, () => d.live.settled());
        await tick();
      }
      await clock.advanceTo(to, () => d.live.settled());
      await tick();
    },
    /** Two minutes of driving, from 17:00. */
    road: () => d.run(at('17:00'), 120, 14),
    /** Parked for good, from 17:02:05, and the clock past the hold's end. */
    async park() {
      await d.run(at('17:02:05'), 40, 0);
      await d.wait(at('17:02:05') + 10 * 60_000);
    },
    /** The page reloads: Live starts anew from its record, on this clock. */
    async reload() {
      d.live.dispose();
      d.live = await start();
    },
  };
  return d;
}

test('voice on by the user: a drive ends and voice goes off, once, with a note; turned on after that, it stays on', async () => {
  const d = await drive({ setting: 'on' });
  await d.road();
  assert.deepEqual([d.k.voice.on, d.k.voice.mode.why], [true, 'on'], 'the user\'s own On doesn\'t say driving');
  await d.park();
  assert.equal(d.k.voice.on, false);
  assert.deepEqual(d.notes, [STOPPED]);
  assert.equal((await readAppSettings(d.k.ws)).voice.mode, 'off', 'kept: a reload doesn\'t bring it back');
  await d.k.voice.choose('on');
  await d.wait(d.clock.now() + 15 * 60_000);
  assert.equal(d.k.voice.on, true, 'only at that moment');
  assert.deepEqual(d.notes, [STOPPED]);
  d.live.dispose();
});

test('voice on while driving, the setting off: it reads driving, and goes off about 3 minutes after stopping, with the note', async () => {
  const d = await drive();
  assert.equal(d.k.voice.on, false);
  await d.road();
  assert.deepEqual([d.k.voice.on, d.k.voice.mode.why], [true, 'driving']);
  const parked = at('17:02:05');
  await d.run(parked, 40, 0);
  assert.equal(d.k.voice.on, true);
  let offAt = 0;
  d.k.voice.onChange((/** @type {any} */ m) => { if (!m.on) offAt = d.clock.now(); });
  await d.wait(parked + 10 * 60_000);
  assert.ok(offAt - parked >= 150_000 && offAt - parked <= 210_000, `off ${(offAt - parked) / 1000} s after parking`);
  assert.deepEqual(d.notes, [STOPPED]);
  d.live.dispose();
});

test('without GPS, driving never turns voice on, and turning GPS off during a hold is no drive ending', async () => {
  const d = await drive({ setting: 'on' });
  await d.road();
  await d.run(at('17:02:05'), 70, 0); // moving fast has ended: the hold runs
  await d.live.setLive(false);
  await d.wait(at('17:30'));
  assert.equal(d.k.voice.on, true, 'the setting stays');
  assert.deepEqual(d.notes, []);
  await d.k.voice.choose('off');
  d.sensors.fix({ lat: d.p.lat, lng: d.p.lng, accuracy: 8, speed: 14 });
  await d.live.settled();
  await tick();
  assert.equal(d.k.voice.on, false);
  await d.live.setLive(false);
  d.live.dispose();
});

test('red lights don\'t turn voice off, whichever way it is on', async () => {
  for (const setting of /** @type {const} */ (['on', 'off'])) {
    const d = await drive({ setting });
    await d.road();
    /** @type {boolean[]} */
    const seen = [];
    d.k.voice.onChange((/** @type {any} */ m) => seen.push(m.on));
    await d.run(at('17:02:05'), 75, 0); // a light of 75 s
    await d.run(at('17:03:25'), 60, 14);
    await d.run(at('17:04:30'), 100, 0); // a longer one
    await d.run(at('17:06:15'), 60, 14);
    assert.equal(d.k.voice.on, true, setting);
    assert.deepEqual(seen, [], setting);
    assert.deepEqual(d.notes, [], setting);
    d.live.dispose();
  }
});

test('turned off during a drive, voice stays off until it ends, with no note; the next drive turns it on', async () => {
  for (const setting of /** @type {const} */ (['on', 'off'])) {
    const d = await drive({ setting });
    await d.road();
    await d.k.voice.choose('off');
    assert.equal(d.k.voice.on, false, setting);
    await d.run(at('17:02:05'), 30, 14);
    assert.equal(d.k.voice.on, false, `${setting}: stays off while the drive goes on`);
    await d.reload();
    assert.equal(d.k.voice.on, false, `${setting}: and after a reload`);
    await d.run(at('17:02:40'), 40, 0);
    await d.wait(at('17:15'));
    assert.deepEqual(d.notes, [], setting);
    await d.run(at('17:15:05'), 120, 14);
    assert.deepEqual([d.k.voice.on, d.k.voice.mode.why], [true, 'driving'], setting);
    d.live.dispose();
  }
});

test('a reload during a drive: voice is still on; the drive\'s end comes on time, once', async () => {
  const d = await drive();
  await d.road();
  await d.reload();
  assert.deepEqual([d.k.voice.on, d.k.voice.mode.why], [true, 'driving']);
  const parked = at('17:02:05');
  await d.run(parked, 70, 0); // moving fast has ended: the hold runs
  await d.reload();
  assert.equal(d.k.voice.on, true, 'in the hold');
  await d.wait(parked + 5 * 60_000);
  assert.equal(d.k.voice.on, false);
  assert.deepEqual(d.notes, [STOPPED]);
  await d.reload();
  await tick();
  assert.deepEqual(d.notes, [STOPPED], 'a reload after it says nothing again');
  d.live.dispose();
});

test('a page killed in the hold, opened hours later: voice the user left on goes off with the first fix, once; turned on after that, a reload leaves it on', async () => {
  const d = await drive({ setting: 'on' });
  await d.road();
  await d.run(at('17:02:05'), 70, 0);
  d.live.dispose();
  await d.clock.advanceTo(at('21:00'), () => Promise.resolve());
  d.live = await d.start();
  await tick();
  assert.equal(d.k.voice.on, true, 'the end waits for a fix: she may be driving again');
  await d.fix(at('21:00:05'), 0);
  await until(() => !d.k.voice.on);
  assert.deepEqual(d.notes, [STOPPED]);
  await d.k.voice.choose('on');
  await d.reload();
  await tick();
  assert.equal(d.k.voice.on, true);
  assert.deepEqual(d.notes, [STOPPED]);
  d.live.dispose();
});

test('a page killed in the hold and opened with the user driving again: the end dies with the first fix, which is fast', async () => {
  const d = await drive({ setting: 'on' });
  await d.road();
  await d.run(at('17:02:05'), 70, 0);
  d.live.dispose();
  await d.clock.advanceTo(at('17:08'), () => Promise.resolve());
  d.live = await d.start();
  await d.fix(at('17:08:05'), 14);
  await d.run(at('17:08:10'), 60, 14);
  await tick();
  assert.equal(d.k.voice.on, true);
  assert.deepEqual(d.notes, []);
  assert.equal(d.keep.get().due, null, 'and the record no longer owes it');
  d.live.dispose();
});

test('a choice made since the page opened cancels a late end: Voice on at 09:00, a first good fix at 10:05 after poor ones indoors', async () => {
  for (const how of /** @type {const} */ (['on the road', 'in the hold'])) {
    const d = await drive({ setting: 'on' });
    await d.road();
    if (how === 'in the hold') await d.run(at('17:02:05'), 70, 0);
    d.live.dispose();
    await d.clock.advanceTo(at('21:00'), () => Promise.resolve());
    d.live = await d.start();
    // Indoors: a position, and nothing near good enough to say where she is.
    d.sensors.fix({ lat: d.p.lat, lng: d.p.lng, accuracy: 400, speed: 0 });
    await d.live.settled();
    await d.k.voice.choose('off');
    await d.clock.advanceTo(at('21:30'), () => d.live.settled());
    await d.k.voice.choose('on');
    await d.clock.advanceTo(at('22:05'), () => d.live.settled());
    await d.fix(at('22:05:05'), 0);
    await d.wait(at('22:20'));
    assert.equal(d.k.voice.on, true, how);
    assert.deepEqual(d.notes, [], how);
    assert.equal((await readAppSettings(d.k.ws)).voice.mode, 'on', how);
    d.live.dispose();
  }
});

test('a drive ending in the middle of her sentence: she finishes it, then voice goes off with the note', async () => {
  const speak = { toolCalls: [{ name: 'speak', input: { text: 'Tea time, as you asked.' } }, { name: 'sleep', input: {} }] };
  const d = await drive({ setting: 'on', kit: { halves: true, voice: { mode: 'on', playMs: 1500 } }, rules: [{ match: 'Tea time', reply: speak }, { match: '.', reply: sleep }] });
  await d.road();
  await d.run(at('17:02:05'), 70, 0);
  const due = d.keep.get().due;
  await d.live.setWatch(d.k.trip, { when: { type: 'time', at: new Date(due - 20_000).toISOString() }, fallback: 'Tea time.' });
  await d.clock.advanceTo(due - 20_000, () => d.live.settled());
  await until(() => d.k.voice.speaker.speaking, 3000);
  await d.clock.advanceTo(due, () => d.live.settled());
  await tick();
  assert.equal(d.k.voice.on, true, 'she is still speaking');
  assert.ok(!d.k.platform.log.some((/** @type {string} */ l) => l.startsWith('stop')), 'not cut mid-word');
  await until(() => !d.k.voice.on, 5000);
  assert.ok(!d.k.platform.log.some((/** @type {string} */ l) => l.startsWith('stop')), 'she finished');
  assert.deepEqual(d.notes, [STOPPED]);
  assert.equal((await readAppSettings(d.k.ws)).voice.mode, 'off');
  d.live.dispose();
});

test('a drive ending while she listens to the user: the microphone stays open for that turn', async () => {
  const d = await drive({ setting: 'on', kit: { halves: true, voice: { mode: 'on', speechIn: ['m-hear'] } } });
  await d.road();
  await d.run(at('17:02:05'), 70, 0);
  const due = d.keep.get().due;
  d.k.agent.tap();
  await until(() => d.k.agent.state.name === 'listening');
  await d.clock.advanceTo(due, () => d.live.settled());
  await tick();
  assert.equal(d.k.voice.on, true);
  assert.equal(d.k.agent.state.name, 'listening', 'not closed on the user');
  assert.deepEqual(d.notes, [], 'the note waits for the turn to end');
  d.live.dispose();
});

test('a light of 170 s: green at 170 s, and voice stays on through the moment its hold would end, with the speeds fast and the activity not yet', async () => {
  for (const setting of /** @type {const} */ (['on', 'off'])) {
    const d = await drive({ setting });
    await d.road();
    /** @type {boolean[]} */
    const seen = [];
    d.k.voice.onChange((/** @type {any} */ m) => seen.push(m.on));
    await d.run(at('17:02:05'), 165, 0);
    await d.run(at('17:04:55'), 90, 14);
    assert.equal(d.live.activity, 'moving-fast', setting);
    assert.equal(d.k.voice.on, true, setting);
    assert.deepEqual(seen, [], setting);
    assert.deepEqual(d.notes, [], setting);
    d.live.dispose();
  }
});

test('a page killed on the road, opened parked: the drive ended unseen, so voice left on goes off at the first fix', async () => {
  const d = await drive({ setting: 'on' });
  await d.road();
  d.live.dispose();
  await d.clock.advanceTo(at('21:00'), () => Promise.resolve());
  d.live = await d.start();
  assert.equal(d.k.voice.on, true);
  await d.fix(at('21:00:05'), 0);
  await until(() => !d.k.voice.on);
  assert.deepEqual(d.notes, [STOPPED]);
  d.live.dispose();
});

test('a reminder due in the moment a drive ends is said first; then voice goes off, and the note comes after it', async () => {
  const speak = { toolCalls: [{ name: 'speak', input: { text: 'Tea time, as you asked.' } }, { name: 'sleep', input: {} }] };
  const d = await drive({ setting: 'on', kit: { halves: true }, rules: [{ match: 'Tea time', reply: speak }, { match: '.', reply: sleep }] });
  await d.road();
  await d.run(at('17:02:05'), 70, 0);
  const due = d.keep.get().due;
  assert.equal(typeof due, 'number');
  await d.live.setWatch(d.k.trip, { when: { type: 'time', at: new Date(due).toISOString() }, fallback: 'Tea time.' });
  await d.clock.advanceTo(due, () => d.live.settled());
  await eventually(async () => (await d.k.events(['out.speak'])).length > 0);
  const [said] = await d.k.events(['out.speak']);
  assert.equal(said.data.voice, true, 'said aloud, not a bubble');
  await until(() => !d.k.voice.on, 3000);
  assert.deepEqual(d.notes, [STOPPED]);
  assert.equal((await readAppSettings(d.k.ws)).voice.mode, 'off');
  d.live.dispose();
});

test('reminders: while off, shown; while driving, said aloud', async () => {
  const quiet = await drive({ kit: { halves: true } });
  await quiet.live.setWatch(quiet.k.trip, { when: { type: 'time', at: new Date(at('17:01')).toISOString() }, fallback: 'Fuel soon.' });
  quiet.live.online = false; // no connection: annai says the reminder itself
  await quiet.wait(at('17:01'));
  await eventually(async () => (await quiet.k.events(['reminder'])).length > 0);
  assert.deepEqual((await quiet.k.events(['reminder'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.aloud)]), [['Fuel soon.', false]]);
  quiet.live.dispose();

  const road = await drive({ kit: { halves: true } });
  await road.road();
  await road.live.setWatch(road.k.trip, { when: { type: 'time', at: new Date(at('17:03')).toISOString() }, fallback: 'Fuel soon.' });
  road.live.online = false;
  await road.run(at('17:02:05'), 60, 14);
  await eventually(async () => (await road.k.events(['reminder'])).length > 0);
  assert.deepEqual((await road.k.events(['reminder'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.aloud)]), [['Fuel soon.', true]]);
  road.live.dispose();
});

const PHONE = { kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'phone' };
const BUDS = { kind: 'audioinput', label: 'Somebody\'s buds', deviceId: 'buds' };
const RECEIVER = { kind: 'audioinput', label: 'Receiver', deviceId: 'receiver' };
const WATCH = { kind: 'audiooutput', label: 'A watch', deviceId: 'watch' };
const NAMELESS = { kind: 'audiooutput', label: '', deviceId: 'zz9' };
/** What the microphone opens with: the fake's `input` is what its open track says it is on. @param {any} k @param {{ label: string, deviceId: string }} input */
const openMic = (k, input) => { k.platform.input = input; return k.platform.mic.open({ onFrames() {} }); };

/** @param {any} [voice] */
async function plugged(voice = {}) {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'A long sentence, on and on.' } }, { name: 'sleep', input: {} }] }]], { voice: { playMs: 400, ...voice } });
  /** @type {string[]} */
  const notes = [];
  k.voice.onNote((/** @type {string} */ n) => notes.push(n));
  k.platform.setDevices([PHONE, BUDS]);
  await tick();
  return { k, notes };
}

test('the input the microphone is open on disappears: voice goes off at once, mid-word, stays off, with a note naming it and the Trace\'s voice.route', async () => {
  const { k, notes } = await plugged();
  assert.equal(k.voice.on, true);
  await openMic(k, { label: BUDS.label, deviceId: 'buds' });
  k.agent.send('Say something long');
  await until(() => k.voice.speaker.speaking, 2000);
  k.platform.setDevices([PHONE]);
  await until(() => !k.voice.on);
  assert.equal(k.voice.speaker.speaking, false, 'mid-word');
  assert.deepEqual(notes, [`Voice off: ${BUDS.label} disconnected`]);
  assert.equal((await readAppSettings(k.ws)).voice.mode, 'off');
  await tick();
  const traced = await k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS_DEVICE, { types: ['voice.route'] }));
  assert.deepEqual(traced.at(-1).data.gone, ['Somebody\'s buds']);
  await k.agent.idle();
});

test('an input with an id and no name is named by what it is: the note says the microphone', async () => {
  const { k, notes } = await plugged();
  await openMic(k, { label: '', deviceId: 'buds' });
  k.platform.setDevices([PHONE]);
  await until(() => !k.voice.on);
  assert.deepEqual(notes, [UNPLUGGED]);
});

test('anything else coming or going leaves voice on and no note: a Receiver that comes with the microphone and goes as it closes, a watch, a nameless id, the microphone closed, a list with nothing to go by', async () => {
  const { k, notes } = await plugged();
  // The microphone not open: nothing says what she was listening on.
  k.platform.setDevices([PHONE, WATCH, NAMELESS]);
  await tick();
  assert.equal(k.voice.on, true, 'the buds went with no microphone open');
  // A Receiver that comes as the microphone opens on the buds, goes mid-listen, comes again, and goes as the microphone closes.
  k.platform.setDevices([PHONE, BUDS, RECEIVER]);
  const mic = await openMic(k, { label: BUDS.label, deviceId: 'buds' });
  await tick();
  k.platform.setDevices([PHONE, BUDS]);
  await tick();
  assert.equal(k.voice.on, true, 'the Receiver went mid-listen');
  k.platform.setDevices([PHONE, BUDS, RECEIVER, WATCH, NAMELESS]);
  await tick();
  k.platform.setDevices([PHONE, BUDS, RECEIVER, NAMELESS]);
  await tick();
  assert.equal(k.voice.on, true, 'a watch and a nameless id went mid-listen');
  mic.close();
  k.platform.setDevices([PHONE, BUDS]);
  await tick();
  assert.equal(k.voice.on, true, 'the Receiver went as the microphone closed');
  // A list with nothing named or identified says nothing (the microphone no longer allowed), and an id that changes with the same name is the same input.
  await openMic(k, { label: PHONE.label, deviceId: 'phone' });
  k.platform.setDevices([{ kind: 'audioinput', label: '', deviceId: '' }]);
  await tick();
  assert.equal(k.voice.on, true, 'nothing to go by');
  k.platform.setDevices([{ ...PHONE, deviceId: 'phone2' }]);
  await tick();
  assert.equal(k.voice.on, true, 'the same name');
  assert.deepEqual(notes, []);
  // With voice off already, nothing is said either.
  await k.voice.choose('off');
  k.platform.input = { label: 'Gone', deviceId: 'gone' };
  k.platform.setDevices([PHONE]);
  await tick();
  assert.deepEqual(notes, []);
});

test('the input the microphone is open on disappearing ends a tap\'s hold too, and during a drive voice stays off until it ends', async () => {
  const d = await drive();
  d.k.platform.setDevices([PHONE, BUDS]);
  await tick();
  await d.road();
  assert.deepEqual([d.k.voice.on, d.k.voice.mode.why], [true, 'driving']);
  await openMic(d.k, { label: BUDS.label, deviceId: 'buds' });
  d.k.platform.setDevices([PHONE]);
  await until(() => !d.k.voice.on);
  await d.run(at('17:02:05'), 30, 14);
  assert.equal(d.k.voice.on, false);
  assert.deepEqual(d.notes, [`Voice off: ${BUDS.label} disconnected`]);
  d.live.dispose();
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { halves: true, voice: { mode: 'off', speechIn: ['m-hear'] } });
  k.platform.setDevices([PHONE, BUDS]);
  await tick();
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  k.platform.input = { label: BUDS.label, deviceId: 'buds' };
  k.platform.setDevices([PHONE]);
  await until(() => !k.voice.on);
  assert.notEqual(k.agent.state.name, 'listening');
});

test('the prompts\' voice line says what is so, and never auto', () => {
  const line = (/** @type {any} */ m) => nowBlock({ now: 0, timeZone: 'UTC', voice: m.on ? 'on' : 'off', online: true, reasons: [], plan: null, voiceWhy: voiceWhy(m) }).split('\n').find((l) => l.startsWith('voice:'));
  assert.match(String(line({ setting: 'off', on: true, why: 'driving' })), /^voice: on .*\(while driving\)$/);
  assert.match(String(line({ setting: 'off', on: true, why: 'tapped' })), /^voice: on .*\(the user tapped Shiori, for this exchange\)$/);
  assert.match(String(line({ setting: 'on', on: true, why: 'on' })), /^voice: on [^(]*\([^)]*\)$/);
  assert.doesNotMatch(String(line({ setting: 'off', on: false, why: 'off' })), /auto/);
});

/** A record as a page killed on the road (activity moving fast) leaves it, with its place and what it owes. @param {any} p @param {any} [more] */
const record = (p, more = {}) => ({ at: at('17:03'), odometer: 1.2, odo: { ...p, at: at('17:02:30'), accuracy: 8 }, activity: 'moving-fast', ended: null, due: null, hushed: false, ...more });

/** A page killed in the hold, opened at `now` with GPS on: voice left on, the record owing its end. @param {any} d @param {number} now @param {any} [more] */
async function reopened(d, now, more = {}) {
  d.live.dispose();
  d.keep.set(record(d.p, { activity: 'still', due: at('17:05'), ...more }));
  await d.clock.advanceTo(now, () => Promise.resolve());
  d.live = await d.start();
  await tick();
}

test('a simulated drive\'s end holds nothing of the user\'s voice: the user\'s setting stays', async () => {
  const d = await drive({ setting: 'on' });
  let held = 0;
  d.k.agent.holdVoice = () => { held++; }; // Halves has it; the kit's bare Agent doesn't
  const sim = new ManualClock(at('09:00'));
  const back = await d.live.simulate({ clock: sim, timeZone: () => LA, trip: d.k.trip });
  await d.live.setLive(true);
  let p = MONTEREY;
  for (let t = at('09:00'); t <= at('09:02'); t += 5000) {
    await sim.advanceTo(t, () => d.live.settled());
    p = off(p, 0, -70);
    d.live.fixed({ lat: p.lat, lng: p.lng, accuracy: 8, speed: 14 });
    await d.live.settled();
  }
  for (let t = at('09:02:05'); t <= at('09:12'); t += 5000) {
    await sim.advanceTo(t, () => d.live.settled());
    d.live.fixed({ lat: p.lat, lng: p.lng, accuracy: 8, speed: 0 });
    await d.live.settled();
  }
  assert.equal(d.live.activity, 'still', 'the simulated drive ended');
  assert.equal(held, 0);
  assert.equal(d.k.voice.on, true);
  await back();
  d.live.dispose();
});

test('a page opened after its drive\'s end came due, the first fix with no speed and a coarse accuracy: the way from the record\'s place says she is driving, so the end dies', async () => {
  const d = await drive({ setting: 'on' });
  await reopened(d, at('17:06'));
  assert.equal(d.k.voice.on, true);
  const far = off(d.p, 0, -6000); // 6 km in about 4 minutes
  d.sensors.fix({ lat: far.lat, lng: far.lng, accuracy: 60, speed: null });
  await d.live.settled();
  await d.wait(at('17:20'));
  assert.equal(d.k.voice.on, true);
  assert.deepEqual(d.notes, []);
  assert.equal(d.keep.get().due, null, 'and the record no longer owes it');
  d.live.dispose();
});

test('a first fix that can say nothing of the speed (no place to judge from, no speed) leaves the end waiting for the next good fix', async () => {
  const d = await drive({ setting: 'on' });
  await reopened(d, at('17:06'), { odo: null });
  d.sensors.fix({ lat: d.p.lat, lng: d.p.lng, accuracy: 60, speed: null });
  await d.live.settled();
  await tick();
  assert.equal(d.k.voice.on, true, 'a fix that says nothing ends nothing');
  await d.fix(at('17:06:05'), 0);
  await until(() => !d.k.voice.on);
  assert.deepEqual(d.notes, [STOPPED]);
  d.live.dispose();
});

test('a late end with GPS on and no fix good enough: voice goes off after FIX_WAIT_MS, and a choice made meanwhile still cancels it', async () => {
  for (const choose of [false, true]) {
    const d = await drive({ setting: 'on' });
    await reopened(d, at('21:00'));
    d.sensors.fix({ lat: d.p.lat, lng: d.p.lng, accuracy: 400, speed: 0 }); // indoors
    await d.live.settled();
    await d.clock.advanceTo(at('21:00') + FIX_WAIT_MS - 1000, () => d.live.settled());
    assert.equal(d.k.voice.on, true, 'it waits for a fix first');
    if (choose) await d.k.voice.choose('on');
    await d.wait(at('21:00') + FIX_WAIT_MS + 70_000);
    assert.equal(d.k.voice.on, choose, `${choose ? 'chosen' : 'nothing chosen'}`);
    assert.deepEqual(d.notes, choose ? [] : [STOPPED]);
    d.live.dispose();
  }
});
