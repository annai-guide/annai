import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceMode, routeOf, chipText } from '../../src/core/voice/mode.js';
import { Voice } from '../../src/core/voice/voice.js';
import { voiceSettings } from '../../src/core/voice/settings.js';
import { Registry } from '../../src/core/registry.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes } from '../../src/core/scopes.js';
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
  assert.equal(routeOf([input('JBL Flip 5')]), 'headphones', 'a brand nobody listed is still not the phone');
  assert.equal(routeOf([input('iPhone Microphone'), input("Kevin's car")]), 'car');
  assert.equal(routeOf([input('CarPlay')]), 'car');
  assert.equal(routeOf([{ kind: 'audiooutput', label: 'Toyota Camry' }]), 'car');
  assert.equal(routeOf([{ kind: 'videoinput', label: 'Car camera' }]), 'unknown');
});

test('the chip says what voice is now', () => {
  assert.equal(chipText({ setting: 'auto', on: false, why: 'phone speaker' }), 'Voice auto · off');
  assert.equal(chipText({ setting: 'auto', on: true, why: 'car audio' }), 'Voice on · car audio');
  assert.equal(chipText({ setting: 'on', on: true, why: 'on' }), 'Voice on');
  assert.equal(chipText({ setting: 'off', on: false, why: 'off' }), 'Voice off');
});

/** A Voice over a fake device with these audio devices. @param {{ kind: string, label: string }[]} [devices] */
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
  return { voice, platform, registry, ws, changes };
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
