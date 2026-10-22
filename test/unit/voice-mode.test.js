import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceMode, routeOf, chipText } from '../../src/core/voice/mode.js';
import { Voice } from '../../src/core/voice/voice.js';
import { voiceSettings } from '../../src/core/voice/settings.js';
import { Registry } from '../../src/core/registry.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, ME } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { Agent } from '../../src/core/agent/loop.js';
import { fakePlatform, fakeLlm } from './voice-fakes.js';
import { agentKit, until } from './agent-kit.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('Auto: on when moving fast, with headphones or car audio; off on the speaker; else the last choice there (spec §10.5)', () => {
  const auto = (/** @type {any} */ c) => voiceMode({ setting: 'auto', activity: 'unknown', route: 'unknown', lastChoices: {}, ...c });
  assert.deepEqual(voiceMode({ setting: 'on', activity: 'still', route: 'speaker', lastChoices: {} }), { setting: 'on', on: true, why: 'on' });
  assert.deepEqual(voiceMode({ setting: 'off', activity: 'moving-fast', route: 'car', lastChoices: {} }), { setting: 'off', on: false, why: 'off' });
  assert.deepEqual(auto({ activity: 'moving-fast', route: 'speaker' }), { setting: 'auto', on: true, why: 'moving' });
  assert.deepEqual(auto({ route: 'car' }), { setting: 'auto', on: true, why: 'car audio' });
  assert.deepEqual(auto({ route: 'headphones' }), { setting: 'auto', on: true, why: 'headphones' });
  assert.deepEqual(auto({ route: 'speaker', lastChoices: { unknown: 'on' } }), { setting: 'auto', on: false, why: 'phone speaker' });
  assert.deepEqual(auto({ activity: 'walking', lastChoices: { walking: 'on' } }), { setting: 'auto', on: true, why: 'your last choice' });
  assert.deepEqual(auto({ activity: 'walking', lastChoices: { still: 'on' } }), { setting: 'auto', on: false, why: 'not sure' });
});

test("what audio is connected, from the devices' names; nothing to go on without names", () => {
  const input = (/** @type {string} */ label) => ({ kind: 'audioinput', label });
  assert.equal(routeOf([]), 'unknown');
  assert.equal(routeOf([input(''), input('')]), 'unknown');
  assert.equal(routeOf([input('iPhone Microphone')]), 'speaker');
  assert.equal(routeOf([input('Speakerphone'), input('Headset earpiece')]), 'speaker');
  assert.equal(routeOf([input('Default - MacBook Pro Microphone (Built-in)')]), 'speaker');
  assert.equal(routeOf([input('iPhone Microphone'), input('AirPods Pro')]), 'headphones');
  assert.equal(routeOf([input('Speakerphone'), input('Bluetooth headset')]), 'headphones');
  assert.equal(routeOf([input('JBL Flip 5')]), 'unknown', 'a name nobody listed is unknown, not headphones (voice-fix item 5)');
  assert.equal(routeOf([input('iPhone Microphone'), input("Kevin's car")]), 'car');
  assert.equal(routeOf([input('CarPlay')]), 'car');
  assert.equal(routeOf([{ kind: 'audiooutput', label: 'Toyota Camry' }]), 'car');
  assert.equal(routeOf([{ kind: 'videoinput', label: 'Car camera' }]), 'unknown');
});

// voice-fix item 5 (the iPhone trace, 2026-10-22: Auto said "headphones" on the phone's own speaker): the table.
test('routeOf: the phone\'s own names (speaker and receiver too) are the speaker; names nobody listed are unknown, never headphones', () => {
  const input = (/** @type {string} */ label) => ({ kind: 'audioinput', label });
  const output = (/** @type {string} */ label) => ({ kind: 'audiooutput', label });
  for (const [devices, want] of /** @type {[{ kind: string, label: string }[], string][]} */ ([
    [[input('iPhone Microphone')], 'speaker'],
    [[input('iPhone Microphone'), output('Speaker')], 'speaker'],
    [[input('iPhone Microphone'), output('Receiver')], 'speaker'],
    [[input('iPhone Microphone'), input('AirPods Pro')], 'headphones'],
    [[input('Beats Studio Buds')], 'headphones'],
    [[input('Bluetooth headset')], 'headphones'],
    [[input('Wired Headphones')], 'headphones'],
    [[input('iPhone Microphone'), input('Bose QC')], 'unknown'],
    [[input('Fake Default Audio Input'), input('Fake Audio Input 1'), input('Fake Audio Input 2')], 'unknown'],
    [[input('iPhone Microphone'), input('CarPlay')], 'car'],
    [[input('Headset earpiece')], 'speaker'],
    [[input('')], 'unknown'],
  ])) assert.equal(routeOf(devices), want, devices.map((d) => d.label).join(' + '));
});

test('the chip says what voice is now', () => {
  assert.equal(chipText({ setting: 'auto', on: false, why: 'phone speaker' }), 'Voice auto · off');
  assert.equal(chipText({ setting: 'auto', on: true, why: 'car audio' }), 'Voice on · car audio');
  assert.equal(chipText({ setting: 'on', on: true, why: 'on' }), 'Voice on');
  assert.equal(chipText({ setting: 'off', on: false, why: 'off' }), 'Voice off');
});

/** A Voice over a fake device with these audio devices. @param {{ kind: string, label: string, deviceId?: string }[]} [devices] */
async function voiceKit(devices = []) {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const platform = fakePlatform({ devices });
  registry.add('voice-browser', 'voice-platform', platform);
  const voice = new Voice({ llm: fakeLlm(), ws, registry, store, locale: 'en' });
  /** @type {any[]} */
  const changes = [];
  voice.onChange((m) => changes.push(m));
  return { voice, platform, registry, ws, store, changes };
}

test('the Voice follows the devices as they come and go, and the activity sensor when there is one', async () => {
  const k = await voiceKit([{ kind: 'audioinput', label: 'iPhone Microphone' }]);
  assert.equal(await k.voice.refresh(), false);
  assert.equal(k.voice.mode.why, 'phone speaker');
  k.platform.setDevices([{ kind: 'audioinput', label: 'iPhone Microphone' }, { kind: 'audioinput', label: 'AirPods Pro' }]);
  await tick();
  assert.equal(k.voice.on, true);
  assert.deepEqual(k.changes.map((m) => m.why), ['phone speaker', 'headphones']);
  k.platform.setDevices([{ kind: 'audioinput', label: 'iPhone Microphone' }]);
  await tick();
  assert.equal(k.voice.on, false);
  k.registry.add('live', 'activity', { now: () => 'moving-fast' });
  assert.equal(await k.voice.refresh(), true);
  assert.equal(k.voice.mode.why, 'moving');
});

test('an explicit choice where annai cannot tell is remembered for that activity, and Auto uses it (spec §10.5)', async () => {
  const k = await voiceKit([]);
  await k.voice.refresh();
  assert.deepEqual(k.voice.mode, { setting: 'auto', on: false, why: 'not sure' });
  await k.voice.choose('on');
  assert.deepEqual(k.voice.mode, { setting: 'on', on: true, why: 'on' });
  assert.deepEqual(voiceSettings((await k.ws.readJSON('sys:settings', '/app.json')) ?? {}).lastChoices, { unknown: 'on' });
  await k.voice.choose('auto');
  assert.deepEqual(k.voice.mode, { setting: 'auto', on: true, why: 'your last choice' });
  const known = await voiceKit([{ kind: 'audioinput', label: 'iPhone Microphone' }]);
  await known.voice.choose('on');
  assert.deepEqual(voiceSettings((await known.ws.readJSON('sys:settings', '/app.json')) ?? {}).lastChoices, {}, 'with the speaker known, there is nothing to learn');
});

test('Shiori hears about voice changes: a state event, the now block, and the microphone closing when voice goes off (spec §4.5, §6.3)', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: { mode: 'off' } });
  await k.voice.choose('auto');
  k.platform.setDevices([{ kind: 'audioinput', label: 'Toyota Camry' }]);
  await until(() => k.voice.on);
  k.agent.send('Hi');
  await until(() => k.agent.state.name === 'listening');
  assert.match(k.requests[0].tail, /voice: on .*\(auto: car audio\)/);
  await k.voice.choose('off');
  await k.agent.idle();
  const states = (await k.events(['state'])).map((/** @type {any} */ e) => [e.data.voice, e.data.setting, e.data.why]);
  assert.deepEqual(states.slice(-2), [['on', 'auto', 'car audio'], ['off', 'off', 'off']]);
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l.startsWith('mic ')).at(-1), 'mic close');
  // Voice going off while a tap's window listens: the window closes, and the dock says she sleeps, so the next tap opens typing.
  await k.voice.choose('on');
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await k.voice.choose('off');
  assert.equal(k.agent.state.name, 'sleeping');
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l.startsWith('mic ')).at(-1), 'mic close');
  assert.equal(k.agent.tap(), 'typing');
});

test('the voice mode read as annai starts is no change: nothing is logged for it, and the next real change is (spec §4.5)', async () => {
  // As the app starts: the Agent hears the Voice before its first reading lands.
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  registry.add('voice-browser', 'voice-platform', fakePlatform({ devices: [{ kind: 'audioinput', label: 'iPhone Microphone' }] }));
  await updateAppSettings(ws, { voice: { mode: 'off' } });
  const voice = new Voice({ llm: fakeLlm(), ws, registry, store, locale: 'en' });
  new Agent({ store, ws, llm: fakeLlm(), registry, voice });
  await voice.refresh();
  const states = async () => (await store.tx(['events'], 'readonly', (t) => t.listEvents(ME, { types: ['state'] }))).map((e) => e.data.voice);
  await tick();
  assert.deepEqual(await states(), []);
  await voice.choose('on');
  await tick();
  assert.deepEqual(await states(), ['on']);
});

// voice-fix item 5: while the microphone is open, the route is the input in use, not the devices present.
test('while the microphone is open, the route is the one input in use (its label, else its deviceId), and each decision is traced, with the names, on this device only', async () => {
  const k = await voiceKit([{ kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'phone' }, { kind: 'audioinput', label: 'AirPods Pro', deviceId: 'pods' }]);
  assert.equal(await k.voice.route(), 'headphones', 'closed: the devices present');
  k.platform.input = { label: 'iPhone Microphone', deviceId: 'phone' }; // AirPods connected, in their case: the phone's mic is in use
  const mic = await k.platform.mic.open({ onFrames: () => {}, onError: () => {} });
  assert.equal(await k.voice.route(), 'speaker', 'open: the input in use');
  k.platform.input = { label: '', deviceId: 'pods' };
  assert.equal(await k.voice.route(), 'headphones', 'a track with no label: named by its deviceId');
  k.platform.input = { label: '', deviceId: 'gone' };
  assert.equal(await k.voice.route(), 'unknown');
  mic.close();
  assert.equal(await k.voice.route(), 'headphones');
  await tick();
  const { SYS_DEVICE } = await import('../../src/core/scopes.js');
  const traced = (await k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS_DEVICE, { types: ['voice.route'] }))).map((/** @type {any} */ e) => [e.data.route, e.data.using, e.data.devices.join(' + ')]);
  assert.deepEqual(traced, [
    ['headphones', null, 'iPhone Microphone + AirPods Pro'],
    ['speaker', 'iPhone Microphone', 'iPhone Microphone + AirPods Pro'],
    ['headphones', 'AirPods Pro', 'iPhone Microphone + AirPods Pro'],
    ['unknown', '', 'iPhone Microphone + AirPods Pro'],
    ['headphones', null, 'iPhone Microphone + AirPods Pro'],
  ], 'each change once, in this device\'s own scope (never exported)');
});
