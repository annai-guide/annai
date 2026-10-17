# Milestone 3c: Voice Modes and the Car Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice works out when to be on, is one tap away, and suits the car:
- **Voice mode Auto / On / Off** (spec §10.5): Auto turns voice on when moving fast, or when headphones or car audio are connected, and off on the phone's speaker; where the browser can't tell, it follows the user's last explicit choice in that situation. Changes are logged as `state` events (§4.5) and told to Shiori in the now block.
- **The voice chip**, always one tap away, at the top of the dock.
- **The voice layout of the dock** (§16.2: voice layouts enlarge the dock, never move it), **"Show what she's saying"** (§16.2), and spoken words kept hidden in the conversation unless asked (§2 principle 4, §16.1).
- **Steering-wheel media buttons as a talk button** (§18's experiment), through the Media Session API.
- **The milestone's "Done when":** the spoken back-and-forth, an interruption and a checked chatter end to end in both browsers, and the device checklist for the car (`docs/testing/device-checklist-m3.md`).

**Architecture:**
- `src/core/voice/mode.js` (pure): `voiceMode()` and `routeOf()`; the `Voice` works out its mode from the setting, the activity sensor (registry kind `activity`, which live mode brings in milestone 5) and the audio devices' names (the voice-browser plugin's `devices()`).
- `src/ui/voice-chip.js`, `src/ui/media-keys.js`; the dock and the conversation screen.

**Tech Stack:** as 3a and 3b.

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`: §10.5, §4.5 (`state`), §6.3 (the now block's voice mode), §16.1–16.2 (spoken words hidden unless asked; voice layouts; "Show what she's saying"), §18 (device checklist: car Bluetooth, ducking, the first tap, dictation in the installed app, headphone or car-audio detection, steering-wheel buttons, CarPlay and Android Auto).

**Not in this plan:**
- **The Driving screen** (§16.2: route strip, maps card, quick-ask buttons): it shows live mode's route and position, milestone 5. This plan gives the voice parts it needs (the voice dock, the caption).
- **Where "moving fast" comes from:** live mode's activity sensor (§11.2, milestone 5). Auto reads it through the registry; until it exists, activity is "unknown" (Choice 2).

## Choices this plan makes (please check them)

1. **The voice chip sits at the top of the dock** ("Voice auto · off", "Voice on · car"), on every screen, where a thumb reaches; tapping it shows Auto, On and Off. The mockup puts status chips under the top bar; the top bar is full on a phone.
2. **Auto's "moving fast" waits for live mode.** Moving fast comes from the activity sensor (GPS speed), which runs only in live mode (§11.1, milestone 5). Auto asks for it now and gets "unknown" until then; it decides from headphones and car audio, then from your last choice. Turning on GPS for voice alone would send no data anywhere, but it is a battery and privacy change §11.1 doesn't make. *Cost if wrong:* before milestone 5, Auto doesn't turn voice on in a car whose audio it can't recognize.
3. **Headphones and car audio are recognized by the names of audio devices,** which browsers give only after the microphone was allowed: a known car name (or "CarPlay", "hands-free") is car audio; anything else that isn't the phone's own (iPhone microphone, speakerphone, earpiece) is headphones. Before the microphone was allowed, Auto can't tell, and uses your last choice.
4. **"Your last explicit choice in that situation":** choosing On or Off on the chip (or in Settings) while annai can't tell what audio is connected remembers it for the current activity (still, walking, moving fast, or unknown); Auto uses it there later.
5. **Spoken lines in the conversation are folded:** a Shiori bubble said aloud shows "Said aloud" and a "Show" button. What was heard from you stays shown, in words (3b's choice 5).
6. **"Show what she's saying" is a button on the dock while voice is on;** it shows the words of what she is saying (or last said) above the dock until tapped again.
7. **Steering-wheel buttons:** with voice on, play, pause, stop and next or previous track on the car's media controls act like a tap on Shiori. Browsers send these only to a page that played sound lately; it is an experiment the checklist tries.
8. **Voice mode changes are logged** as `state` events in the conversation they happened in (`{ voice: 'on' | 'off', setting, why }`), so the trace and a later replay show them.

## Global Constraints

- All of 3a's and 3b's Global Constraints hold.
- **"The setting is always one tap away" (§10.5).**
- **"Voice layouts, such as driving, enlarge the dock; they never move it" (§16.2).**
- **"Spoken content isn't shown as text unless asked" (§2 principle 4); "Spoken words hidden unless asked" (§16.1).**
- **The now block tells Shiori the voice mode (§6.3, §6.7).**
- **Accessibility (§16.5):** labelled controls, large targets (44 px at least), visible focus; the chip's menu works with a keyboard.

## Review Focus

1. **Audio devices that come and go:** headphones unplugged while she speaks, a car connecting mid-drive, a device list that is empty because the microphone wasn't allowed yet. Auto changes at once, says so in the chip and the log, and never turns voice on in the middle of her typed-mode turn in a way that leaves a listening window open. Pinned in Task 1 and Task 2.
2. **A chip tapped during a turn:** switching voice off while she listens closes the microphone; switching on while she thinks takes effect at her next turn. Pinned in Task 3.
3. **Device names that are odd:** a Bluetooth speaker with a brand name, a car with the owner's name ("Kevin's car"), Android's "Headset earpiece" (the phone's own). Pinned in Task 1.
4. **Media buttons when voice is off, or before any sound played:** nothing happens, and nothing breaks. Pinned in Task 4.
5. **Folded spoken lines and a screen reader:** the button says what it does; the text is reachable once shown. Pinned in Task 3.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/voice/mode.js` | 1 | `voiceMode`, `routeOf`, `chipText` |
| `src/core/voice/voice.js`, `src/core/voice/settings.js`, `src/core/voice/platform.js` | 1 | the mode; `choose()`; `onChange()`; `lastChoices` |
| `src/core/agent/loop.js`, `src/core/agent/context.js` | 1 | `state` events; the now block's why |
| `src/plugins/voice-browser/index.js`, `test/browser/suites/voice.js` | 2 | `devices()`, `onDeviceChange()` |
| `src/ui/voice-chip.js`, `src/ui/dock.js`, `src/ui/shiori.css`, `src/ui/screens/talk.js`, `src/ui/screens/voice.js` | 3 | the chip, the voice dock, the caption, folded spoken lines |
| `src/ui/media-keys.js`, `src/app/main.js` | 4 | steering-wheel buttons |
| `test/e2e/voice-talk.spec.js`, `test/e2e/voice-modes.spec.js`, `docs/testing/device-checklist-m3.md`, `README.md` | 3, 5 | end to end; the checklist; the README |

---
### Task 1: Voice mode Auto / On / Off

**Files:**
- Create: `src/core/voice/mode.js`
- Modify: `src/core/voice/voice.js`, `src/core/voice/settings.js`, `src/core/voice/platform.js`, `src/core/agent/loop.js`, `src/core/agent/context.js`, `test/unit/voice-fakes.js`, `test/unit/voice-listening.test.js` and `test/unit/voice-service.test.js` (settings defaults), `sw.js`
- Test: `test/unit/voice-mode.test.js`

**Interfaces:**
- Consumes: the Voice of 3a/3b; the registry; `updateAppSettings`.
- Produces:
  - `mode.js`: `VoiceMode = { setting: 'auto' | 'on' | 'off', on: boolean, why: string }`; `voiceMode({ setting, activity, route, lastChoices }): VoiceMode`; `routeOf(devices: { kind, label }[]): 'car' | 'headphones' | 'speaker' | 'unknown'`; `chipText(mode): string`.
  - `voiceSettings(app).lastChoices: Record<string, 'on' | 'off'>` (by activity).
  - `VoicePlatform` gains optional `devices(): Promise<{ kind, label }[]>` and `onDeviceChange(fn)`.
  - `Voice`: `mode: VoiceMode`; `get on(): boolean`; `refresh()` works out the mode (setting, the activity sensor, the devices' names) and tells `onChange` listeners when it changes; `activity()`; `route()`; `choose(setting)`; `onChange(fn): () => void`. An activity sensor is a registry item of kind `activity` with `now(): 'still' | 'walking' | 'moving-fast' | 'unknown'` and optional `onChange(fn)`.
  - The agent logs `state` events `{ voice: 'on' | 'off', setting, why }` when the mode changes; voice turning off closes the microphone, stops her voice, and turns her current turn to bubbles. The now block says `voice: on (…) (auto: car audio)`.
  - `fakePlatform({ devices? })` with `setDevices(list)`.

- [ ] **Step 1: Write the failing test**

In `test/unit/voice-fakes.js`, give `fakePlatform` a `devices = []` option (type `devices?: { kind: string, label: string }[]`), and add to the platform object:

```js
    /** @type {{ kind: string, label: string }[]} */
    deviceList: devices,
    /** @type {(() => void)[]} */
    deviceChanges: [],
    async devices() { return platform.deviceList; },
    /** @param {() => void} fn */
    onDeviceChange(fn) { platform.deviceChanges.push(fn); },
    /** Plugs in or unplugs audio devices. @param {{ kind: string, label: string }[]} list */
    setDevices(list) {
      platform.deviceList = list;
      for (const fn of platform.deviceChanges) fn();
    },
```

In `test/unit/voice-listening.test.js` and `test/unit/voice-service.test.js`, the expected defaults of `voiceSettings({})` gain `lastChoices: {}`.

`test/unit/voice-mode.test.js`:

```js
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/voice-mode.test.js`
Expected: FAIL with `Cannot find module '…/src/core/voice/mode.js'`

- [ ] **Step 3: Write the implementation**

`src/core/voice/mode.js`:

```js
/**
 * Voice mode (spec §10.5): Auto, On or Off, always one tap away. Auto turns voice on when moving
 * fast (driving or riding), or when headphones or car audio are connected, and off on the phone's
 * speaker. Where annai can't tell what audio is connected, Auto follows the user's last explicit
 * choice in that situation: the activity (still, walking, moving fast, or unknown).
 * @typedef {'auto' | 'on' | 'off'} VoiceSetting
 * @typedef {'still' | 'walking' | 'moving-fast' | 'unknown'} Activity
 * @typedef {'car' | 'headphones' | 'speaker' | 'unknown'} Route
 * @typedef {{ setting: VoiceSetting, on: boolean, why: string }} VoiceMode  why: a few words for the chip and the now block
 */

/** @param {{ setting: VoiceSetting, activity: string, route: Route, lastChoices: Record<string, 'on' | 'off'> }} c @returns {VoiceMode} */
export function voiceMode({ setting, activity, route, lastChoices }) {
  if (setting === 'on') return { setting, on: true, why: 'on' };
  if (setting === 'off') return { setting, on: false, why: 'off' };
  if (activity === 'moving-fast') return { setting, on: true, why: 'moving' };
  if (route === 'car') return { setting, on: true, why: 'car audio' };
  if (route === 'headphones') return { setting, on: true, why: 'headphones' };
  if (route === 'speaker') return { setting, on: false, why: 'phone speaker' };
  const last = lastChoices[activity];
  return last ? { setting, on: last === 'on', why: 'your last choice' } : { setting, on: false, why: 'not sure' };
}

/** Names that are a car. */
const CAR = /\b(car|carplay|android auto|hands-?free|uconnect|sync|bmw|audi|mercedes|toyota|honda|ford|kia|hyundai|lexus|nissan|mazda|subaru|volvo|tesla|vw|volkswagen|jeep|chevrolet|chevy|gmc|porsche|mini|skoda|renault|peugeot|citroen|fiat)\b/i;
/** Names that are the phone's (or computer's) own. */
const OWN = /\b(iphone|ipad|built-in|internal|speakerphone|earpiece|default|communications)\b/i;

/**
 * What audio the phone is using, from the names of its audio devices (spec §10.5). Browsers name
 * devices only after the microphone was allowed: without names, annai can't tell.
 * @param {{ kind: string, label: string }[]} devices @returns {Route}
 */
export function routeOf(devices) {
  const named = devices.filter((d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && d.label);
  if (!named.length) return 'unknown';
  const others = named.filter((d) => !OWN.test(d.label));
  if (others.some((d) => CAR.test(d.label))) return 'car';
  return others.length ? 'headphones' : 'speaker';
}

/** The chip's words: "Voice auto · off", "Voice on · car audio", "Voice on", "Voice off". @param {VoiceMode} m */
export function chipText(m) {
  if (m.setting === 'auto') return m.on ? `Voice on · ${m.why}` : 'Voice auto · off';
  return m.on ? 'Voice on' : 'Voice off';
}
```

In `src/core/voice/settings.js`: the typedef gains `lastChoices: Record<string, 'on' | 'off'>` ("an explicit On or Off where annai couldn't tell what audio is connected, by activity (§10.5)"); `VOICE_DEFAULTS` gains `lastChoices: Object.freeze({})`; `voiceSettings` returns also

```js
    lastChoices: Object.fromEntries(Object.entries(v.lastChoices && typeof v.lastChoices === 'object' ? v.lastChoices : {}).filter(([, c]) => c === 'on' || c === 'off')),
```

In `src/core/voice/platform.js`, the `VoicePlatform` typedef gains `devices?(): Promise<{ kind: string, label: string }[]>, onDeviceChange?(fn: () => void): void` ("the audio devices, by name, and when they change (§10.5)").

In `src/core/voice/voice.js`:
- import `{ voiceMode, routeOf }` from `'./mode.js'` and `updateAppSettings` (with `readAppSettings`) from `'../settings.js'`;
- replace the field `on = false;` (and its comment) with:

```js
  /** The voice mode now (spec §10.5); refresh() works it out again. @type {import('./mode.js').VoiceMode} */
  mode = { setting: 'auto', on: false, why: 'not sure' };
  /** @type {Set<(m: import('./mode.js').VoiceMode) => void>} */
  #changes = new Set();
  #watching = false;
```

- replace `refresh()` with:

```js
  /** Whether voice is on now. */
  get on() {
    return this.mode.on;
  }

  /**
   * Works out the voice mode (spec §10.5): the setting; for Auto, the activity sensor and the
   * audio devices' names; and, where it can't tell, the last explicit choice. Listeners hear a change.
   * @returns {Promise<boolean>} whether voice is on
   */
  async refresh() {
    const s = await this.settings();
    const route = s.mode === 'auto' ? await this.route() : 'unknown';
    const next = voiceMode({ setting: s.mode, activity: this.activity(), route, lastChoices: s.lastChoices });
    this.#watch();
    if (next.on !== this.mode.on || next.why !== this.mode.why || next.setting !== this.mode.setting) {
      this.mode = next;
      for (const fn of this.#changes) {
        try {
          fn(next);
        } catch (e) {
          console.warn('a voice listener failed', e);
        }
      }
    }
    return next.on;
  }

  /** What the activity sensor says (live mode's, spec §11.2); unknown without one. @returns {string} */
  activity() {
    try {
      return this.registry.list('activity')[0]?.now?.() ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** What audio is connected, from the devices' names (spec §10.5). */
  async route() {
    try {
      return routeOf((await this.platform?.devices?.()) ?? []);
    } catch {
      return 'unknown';
    }
  }

  /**
   * An explicit choice of Auto, On or Off (spec §10.5). On or Off, where annai can't tell what audio
   * is connected, is remembered for this activity: Auto follows it there.
   * @param {'auto' | 'on' | 'off'} setting
   */
  async choose(setting) {
    /** @type {Record<string, any>} */
    const change = { mode: setting };
    if (setting !== 'auto' && (await this.route()) === 'unknown') change.lastChoices = { [this.activity()]: setting };
    await updateAppSettings(this.ws, { voice: change });
    await this.refresh();
  }

  /** Hears when the voice mode changes. @param {(m: import('./mode.js').VoiceMode) => void} fn @returns {() => void} */
  onChange(fn) {
    this.#changes.add(fn);
    return () => this.#changes.delete(fn);
  }

  /** Devices coming and going, and the activity changing, work out the mode again. */
  #watch() {
    if (this.#watching) return;
    const platform = this.platform;
    if (!platform) return;
    this.#watching = true;
    const again = () => { this.refresh().catch(() => {}); };
    platform.onDeviceChange?.(again);
    this.registry.list('activity')[0]?.onChange?.(again);
  }
```

In `src/core/agent/context.js`, `nowBlock` takes `voiceWhy = ''` (added to its typedef as `voiceWhy?: string`) and its line becomes ``\`voice: ${VOICE[voice] ?? voice}${voiceWhy ? ` (${voiceWhy})` : ''}\` ``.

In `src/core/agent/loop.js`:
- in the constructor, after `this.voice = voice ?? null;`, add `this.voice?.onChange((m) => this.#voiceChanged(m));`;
- the `nowBlock` call gains `voiceWhy: this.voice?.mode.setting === 'auto' ? \`auto: ${this.voice.mode.why}\` : ''`;
- add the method:

```js
  /**
   * The voice mode changed (spec §4.5, §10.5): written in the log. Voice going off closes the
   * microphone, stops her voice, and turns the rest of this turn to bubbles; voice coming on takes
   * effect at her next turn. @param {import('../voice/mode.js').VoiceMode} m
   */
  #voiceChanged(m) {
    record(this.store, this.scope, { type: 'state', actor: 'system', data: { voice: m.on ? 'on' : 'off', setting: m.setting, why: m.why } }).catch(() => {});
    if (m.on) return;
    this.#voiceNow = false;
    this.#closeEar();
    this.voice?.speaker.stop();
    const p = this.#pending?.listening ? this.#pending : null;
    if (p) p.listening = false; // a wait for an answer goes on, for typing
  }
```

In `sw.js`, add `'/src/core/voice/mode.js',` to `SHELL` with the other `src/core/voice/` files.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/voice-mode.test.js test/unit/voice-listening.test.js test/unit/voice-service.test.js test/unit/agent-voice.test.js test/unit/agent-context.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core test/unit sw.js && git commit -m "Voice mode Auto, On and Off: Auto follows headphones, car audio, the activity sensor and your last choice; changes are logged and told to Shiori (spec §10.5, §4.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 2: The devices, on the device side

**Files:**
- Modify: `src/plugins/voice-browser/index.js`, `test/browser/suites/voice.js`
- Test: the browser suite `voice`

**Interfaces:**
- Consumes: `VoicePlatform.devices`, `onDeviceChange` (Task 1).
- Produces: `browserPlatform().devices()` (from `navigator.mediaDevices.enumerateDevices()`, as `{ kind, label }`; `[]` where there is none) and `onDeviceChange(fn)` (the `devicechange` event).

- [ ] **Step 1: Write the failing test**

Add to `test/browser/suites/voice.js`:

```js
  test('the audio devices by name, and word when they change (spec §10.5)', async () => {
    const real = MediaDevices.prototype.enumerateDevices;
    MediaDevices.prototype.enumerateDevices = async () => /** @type {any} */ ([
      { kind: 'audioinput', label: 'AirPods Pro', deviceId: 'a', groupId: 'g' },
      { kind: 'videoinput', label: 'Back camera', deviceId: 'v', groupId: 'h' },
    ]);
    try {
      const p = browserPlatform();
      assert.deepEqual(await /** @type {any} */ (p).devices(), [{ kind: 'audioinput', label: 'AirPods Pro' }, { kind: 'videoinput', label: 'Back camera' }]);
      let told = 0;
      /** @type {any} */ (p).onDeviceChange(() => { told++; });
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
      assert.equal(told, 1);
    } finally {
      MediaDevices.prototype.enumerateDevices = real;
    }
  });
```

Run: `npx playwright test test/e2e/browser-suites.spec.js --project=chromium -g voice`
Expected: FAIL: `p.devices is not a function`.

- [ ] **Step 2: Write the implementation**

In `src/plugins/voice-browser/index.js`, add to the returned platform (after `dictation`):

```js
    async devices() {
      // Names come only once the microphone was allowed (spec §10.5: without them Auto can't tell).
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      return (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, label: d.label }));
    },
    onDeviceChange(fn) {
      navigator.mediaDevices?.addEventListener?.('devicechange', fn);
    },
```

and add `(the audio devices, for voice Auto)` to the module comment's list.

- [ ] **Step 3: Run the suite in both browsers**

Run: `npx playwright test test/e2e/browser-suites.spec.js --project=chromium -g voice`
Expected: PASS.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/browser-suites.spec.js --project=webkit -g voice`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npm run stamp && npm run check && git add src/plugins/voice-browser test/browser sw.js && git commit -m "The device side names the audio devices and says when they change, for voice Auto (spec §10.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 3: The voice chip, the voice dock, "Show what she's saying", and spoken lines folded

**Files:**
- Create: `src/ui/voice-chip.js`, `test/e2e/voice-modes.spec.js`
- Modify: `src/ui/dock.js`, `src/ui/shiori.css`, `src/ui/screens/talk.js`, `src/ui/screens/voice.js`, `sw.js`
- Test: `test/e2e/voice-modes.spec.js`

**Interfaces:**
- Consumes: `voice.mode`, `voice.choose`, `voice.onChange`, `chipText` (Task 1); `out.speak`'s `data.voice` (3b).
- Produces:
  - `voiceChip(ctx): { el }`: a button (its text the chip's words, `aria-expanded`) and a group "Voice" of three buttons, `Auto`, `On`, `Off`, each with `aria-pressed`.
  - The dock: the chip row on top, with a button "Show what she's saying" (only while voice is on) and a caption under it; the class `voice` on the dock while voice is on (larger Shiori and buttons).
  - The conversation: an `out.speak` said aloud is a bubble "SHIORI · Said aloud" with a button "Show what she said" that shows its words.
  - Settings → Voice's radios use `voice.choose`, so they teach Auto like the chip.

- [ ] **Step 1: Write the failing test**

`test/e2e/voice-modes.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

/** Audio devices with names, as a phone gives them once the microphone is allowed. @param {import('@playwright/test').Page} page @param {string[]} labels */
async function fakeDevices(page, labels) {
  await page.addInitScript((names) => {
    if (typeof MediaDevices === 'undefined') return;
    MediaDevices.prototype.enumerateDevices = async () => /** @type {any} */ (names.map((label, i) => ({ kind: 'audioinput', label, deviceId: String(i), groupId: String(i) })));
  }, labels);
}

test('the voice chip: Auto turns voice on with headphones; On and Off are one tap away; the dock grows with voice (spec §10.5, §16.2)', async ({ page }) => {
  await fakeDevices(page, ['iPhone Microphone', 'AirPods Pro']);
  await openApp(page, '#/trips');
  const chip = page.locator('.voice-chip');
  await expect(chip).toHaveText('Voice on · headphones');
  await expect(page.locator('nav.dock')).toHaveClass(/\bvoice\b/);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'Off' }).click();
  await expect(chip).toHaveText('Voice off');
  await expect(page.locator('nav.dock')).not.toHaveClass(/\bvoice\b/);
  await chip.click();
  await expect(page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
  await expect(chip).toHaveText('Voice on');
  await page.goto('/#/voice');
  await expect(page.getByRole('radio', { name: 'On', exact: true })).toBeChecked();
});

test('where annai cannot tell what audio is connected, Auto follows your last choice (spec §10.5)', async ({ page }) => {
  await fakeDevices(page, ['', '']);
  await openApp(page, '#/trips');
  const chip = page.locator('.voice-chip');
  await expect(chip).toHaveText('Voice auto · off');
  await chip.click();
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
  await expect(chip).toHaveText('Voice on');
  await chip.click();
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'Auto' }).click();
  await expect(chip).toHaveText('Voice on · your last choice');
});

test('spoken words stay hidden unless asked: folded in the conversation, and shown over the dock on request (spec §2, §16.1, §16.2)', async ({ page }) => {
  const server = await startModelServer({
    '/b/v1/messages': sse(anthropicToolReply([{ name: 'speak', input: { text: 'Nepenthe is 25 minutes south.' } }, { name: 'sleep', input: {} }])),
    '/voice/audio/speech': wav,
  });
  try {
    await fakeDevices(page, ['Toyota Camry']);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${server.origin}/b`, key: 'sk-chat-test', model: 'b-model' });
    await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Voice', url: `${server.origin}/voice`, key: 'sk-voice-test', model: 'voice' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByText('1. b-model')).toBeVisible();
    await page.getByLabel('Add a model to speech-out').selectOption({ label: 'voice' });
    await page.getByRole('button', { name: 'Add to speech-out' }).click();
    await expect(page.locator('.voice-chip')).toHaveText('Voice on · car audio');
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('Where should we eat?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => server.bodies('/voice/audio/speech').length).toBe(1);
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk', { timeout: 20_000 });
    const said = page.locator('.convo .shiori.said');
    await expect(said).toContainText('Said aloud');
    await expect(said.getByText('Nepenthe is 25 minutes south.')).toBeHidden();
    await said.getByRole('button', { name: 'Show what she said' }).click();
    await expect(said.getByText('Nepenthe is 25 minutes south.')).toBeVisible();
    const caption = page.locator('.dock .caption');
    await expect(caption).toBeHidden();
    await page.getByRole('button', { name: "Show what she's saying" }).click();
    await expect(caption).toHaveText('Nepenthe is 25 minutes south.');
  } finally {
    await server.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test test/e2e/voice-modes.spec.js --project=chromium`
Expected: FAIL: no `.voice-chip`.

- [ ] **Step 3: Write the implementation**

`src/ui/voice-chip.js`:

```js
import { h } from './dom.js';
import { chipText } from '../core/voice/mode.js';

const SETTINGS = /** @type {const} */ ([['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]);

/**
 * The voice chip (spec §10.5): what voice is now ("Voice auto · off", "Voice on · car audio"),
 * always one tap away; a tap shows Auto, On and Off.
 * @param {any} ctx
 */
export function voiceChip(ctx) {
  const voice = ctx.voice;
  const chip = h('button', { class: 'chip voice-chip', type: 'button', 'aria-expanded': 'false', text: chipText(voice.mode) });
  const close = () => {
    menu.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
  };
  const choices = SETTINGS.map(([setting, label]) => h('button', {
    class: 'btn', type: 'button', 'aria-pressed': String(voice.mode.setting === setting),
    onclick: async () => {
      close();
      await voice.choose(setting);
    },
  }, label));
  const menu = h('div', { class: 'voice-menu', role: 'group', 'aria-label': 'Voice', hidden: true }, ...choices);
  chip.addEventListener('click', () => {
    const opening = menu.hidden;
    menu.hidden = !opening;
    chip.setAttribute('aria-expanded', String(opening));
  });
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') {
      close();
      chip.focus();
    }
  });
  voice.onChange((/** @type {import('../core/voice/mode.js').VoiceMode} */ m) => {
    chip.textContent = chipText(m);
    SETTINGS.forEach(([setting], i) => choices[i].setAttribute('aria-pressed', String(m.setting === setting)));
  });
  return { el: h('div', { class: 'voice-chip-wrap' }, chip, menu) };
}
```

In `src/ui/dock.js`:
- import `voiceChip` from `'./voice-chip.js'`;
- before `const el = h('nav', …)`, add:

```js
  // Voice (spec §10.5, §16.2): the chip, "Show what she's saying", and a larger dock while voice is on.
  const chip = ctx.voice ? voiceChip(ctx) : null;
  const caption = h('p', { class: 'caption', 'aria-live': 'polite', hidden: true });
  let lastSaid = '';
  const showWords = h('button', {
    class: 'chip', type: 'button', 'aria-expanded': 'false', hidden: !ctx.voice?.on,
    onclick: () => {
      caption.hidden = !caption.hidden;
      caption.textContent = lastSaid || 'She hasn’t said anything yet.';
      showWords.setAttribute('aria-expanded', String(!caption.hidden));
    },
  }, "Show what she's saying");
  ctx.agent.on('event', (/** @type {any} */ e) => {
    if (e.type !== 'out.speak' || !e.data?.voice) return;
    lastSaid = String(e.data.text ?? '');
    if (!caption.hidden) caption.textContent = lastSaid;
  });
```

- the `nav` gets `chip ? h('div', { class: 'voice-row' }, chip.el, showWords) : null, caption,` before `sheet`;
- after the `nav` is built, add:

```js
  /** @param {{ on: boolean }} m */
  const layout = (m) => {
    el.classList.toggle('voice', m.on);
    showWords.hidden = !m.on;
    if (!m.on) caption.hidden = true;
  };
  ctx.voice?.onChange(layout);
  if (ctx.voice) layout(ctx.voice.mode);
```

In `src/ui/shiori.css`, add after the dock rules:

```css
/* Voice (spec §16.2): the chip row on the dock; while voice is on, the dock grows, and never moves. */
.voice-row { display: flex; justify-content: center; align-items: center; gap: 8px; max-width: 560px; margin: 0 auto 6px; flex-wrap: wrap; }
.voice-chip-wrap { position: relative; }
.voice-chip, .voice-row .chip { min-height: 32px; border: 1px solid var(--line); cursor: pointer; font: inherit; font-size: 13px; }
.voice-menu { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); display: flex; gap: 6px; padding: 6px;
  background: var(--sheet); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 4px 16px rgb(0 0 0 / .12); }
.voice-menu .btn { min-height: 44px; min-width: 64px; }
.voice-menu .btn[aria-pressed='true'] { background: var(--ai-wash); color: var(--ai); border-color: var(--ai); }
.caption { max-width: 560px; margin: 0 auto 6px; padding: 8px 12px; border-radius: 12px; background: var(--sheet); border: 1px solid var(--line); white-space: pre-line; overflow-wrap: anywhere; }
.dock.voice .seat.dock { width: 92px; height: 92px; }
.dock.voice .seat.dock .av { width: 76px; height: 76px; }
.dock.voice .ib { width: 56px; height: 56px; }
.dock.voice .talk { font-size: 13px; font-weight: 700; color: var(--ink); }
.convo .shiori.said .btn { align-self: flex-start; }
```

and change `body { padding-bottom: 120px; }` to `body { padding-bottom: 170px; }` and the notices' `bottom: calc(96px + …)` to `bottom: calc(140px + env(safe-area-inset-bottom))`.

In `src/ui/screens/talk.js`, the `out.speak` branch becomes:

```js
    if (e.type === 'out.speak') {
      if (!d.voice) return h('li', { class: 'shiori' }, h('span', { class: 'who', text: 'SHIORI' }), h('p', { text: texts.text ?? '' }));
      // Said aloud: hidden unless asked (spec §2 principle 4, §16.1).
      const words = h('p', { text: texts.text ?? '', hidden: true });
      const show = h('button', {
        class: 'btn ghost', type: 'button', 'aria-expanded': 'false',
        onclick: () => {
          words.hidden = !words.hidden;
          show.setAttribute('aria-expanded', String(!words.hidden));
          show.textContent = words.hidden ? 'Show what she said' : 'Hide';
        },
      }, 'Show what she said');
      return h('li', { class: 'shiori said' }, h('span', { class: 'who', text: 'SHIORI' }), h('span', { class: 'sub', text: 'Said aloud' }), show, words);
    }
```

In `src/ui/screens/voice.js`:
- the radios' change handler becomes `async (m) => { await voice.choose(m); modeStatus.textContent = voice.on ? 'Voice is on.' : 'Voice is off.'; ctx.notices.toast('Saved'); }`;
- the "On or off" section's paragraph becomes: `'Auto: on in the car, with headphones, or when moving fast; off on the phone speaker; and where annai can’t tell, what you chose last time. On: Shiori speaks aloud and listens for your answer. Off: she writes, and you type. The chip on the dock changes it too.'`

In `sw.js`, add `'/src/ui/voice-chip.js',` to `SHELL` after `'/src/ui/tokens.css',`.

- [ ] **Step 4: Run the tests**

Run: `npx playwright test test/e2e/voice-modes.spec.js test/e2e/voice-talk.spec.js test/e2e/voice-parts.spec.js test/e2e/shiori.spec.js --project=chromium`
Expected: PASS. (`voice-talk.spec.js` turns voice on in Settings → Voice: it still does.)

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/ui test/e2e sw.js && git commit -m "The voice chip, one tap away; the dock grows with voice; her spoken words stay hidden unless you ask (spec §10.5, §16.1, §16.2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 4: Steering-wheel buttons

**Files:**
- Create: `src/ui/media-keys.js`
- Modify: `src/app/main.js`, `sw.js`
- Test: `test/unit/ui-pure.test.js`

**Interfaces:**
- Consumes: `agent.tap()`; `voice.on`, `voice.onChange`.
- Produces: `mediaKeys({ session, agent, voice }): () => void`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/ui-pure.test.js` (with `import { mediaKeys } from '../../src/ui/media-keys.js';`):

```js
test("steering-wheel and headset buttons tap Shiori while voice is on, and do nothing while it's off (spec §18)", () => {
  /** @type {Record<string, any>} */
  const handlers = {};
  const session = {
    setActionHandler(/** @type {string} */ action, /** @type {any} */ fn) {
      if (action === 'previoustrack') throw new Error('not supported here');
      handlers[action] = fn;
    },
  };
  /** @type {((m: any) => void)[]} */
  const listeners = [];
  const voice = { on: false, onChange: (/** @type {any} */ fn) => { listeners.push(fn); return () => {}; } };
  let taps = 0;
  mediaKeys({ session, agent: { tap: () => { taps++; return 'listening'; } }, voice });
  assert.equal(handlers.play, null);
  for (const fn of listeners) fn({ on: true });
  handlers.play();
  handlers.pause();
  handlers.nexttrack();
  assert.equal(taps, 3);
  for (const fn of listeners) fn({ on: false });
  assert.equal(handlers.pause, null);
  assert.doesNotThrow(() => mediaKeys({ session: undefined, agent: { tap: () => 'typing' }, voice }));
});
```

Run: `node --test test/unit/ui-pure.test.js`
Expected: FAIL with `Cannot find module '…/src/ui/media-keys.js'`.

- [ ] **Step 2: Write the implementation**

`src/ui/media-keys.js`:

```js
/** The media keys a car or headset sends. */
const KEYS = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'];

/**
 * Steering-wheel and headset buttons as a talk button (spec §18: an experiment): while voice is
 * on, the media keys act like a tap on Shiori (stop her, listen, or stop listening). Browsers send
 * them only to a page that played sound lately. A key this browser doesn't know is left alone.
 * @param {{ session: any, agent: { tap(): string }, voice: { on: boolean, onChange(fn: (m: { on: boolean }) => void): () => void } }} c
 * @returns {() => void} stops following the voice mode
 */
export function mediaKeys({ session, agent, voice }) {
  if (!session?.setActionHandler) return () => {};
  /** @param {boolean} on */
  const set = (on) => {
    for (const key of KEYS) {
      try {
        session.setActionHandler(key, on ? () => { agent.tap(); } : null);
      } catch {
        // not a key this browser has
      }
    }
  };
  set(voice.on);
  return voice.onChange((m) => set(m.on));
}
```

In `src/app/main.js`, import `mediaKeys` from `'../ui/media-keys.js'` and, after the `Agent` is made, add:

```js
  // Steering-wheel and headset buttons tap Shiori while voice is on (spec §18, an experiment).
  mediaKeys({ session: /** @type {any} */ (navigator).mediaSession, agent, voice });
```

In `sw.js`, add `'/src/ui/media-keys.js',` to `SHELL` after `'/src/ui/markdown.js',`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `node --test test/unit/ui-pure.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npm run stamp && npm run check && git add src/ui/media-keys.js src/app/main.js test/unit/ui-pure.test.js sw.js && git commit -m "Steering-wheel and headset buttons tap Shiori while voice is on, as an experiment for the car (spec §18)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 5: In the car, end to end; the device checklist; the README

**Files:**
- Modify: `test/e2e/voice-talk.spec.js`, `docs/testing/device-checklist-m3.md`, `README.md`
- Test: `test/e2e/voice-talk.spec.js` (two more tests); the whole suites in both browsers

**Interfaces:**
- Consumes: everything above.
- Produces: the end-to-end proof of an interruption and of chatter, and the hand-run checklist for the car.

- [ ] **Step 1: Write the tests**

Add to `test/e2e/voice-talk.spec.js` (it already has `clipPath`, `wav`, `sse` and `json`):

```js
/** A voice clip of seconds, so there is time to cut her off. @param {number} seconds */
const longWav = (seconds) => ({ status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) });

/** Endpoints for a spoken exchange: main, ears, voice (and a quick-decision model). @param {import('@playwright/test').Page} page @param {string} origin @param {{ decide?: boolean }} [o] */
async function setUpVoice(page, origin, { decide = false } = {}) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${origin}/b`, key: 'sk-chat-test', model: 'b-model' });
  await addEndpoint(page, 'Other: OpenAI-compatible transcription', { name: 'Ears', url: `${origin}/ears`, key: 'sk-ears-test', model: 'ears' });
  await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Voice', url: `${origin}/voice`, key: 'sk-voice-test', model: 'voice' });
  if (decide) await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Decider', url: `${origin}/d`, key: 'sk-decide-test', model: 'd-model' });
  /** @type {[string, string][]} */
  const roles = [['main', 'b-model'], ['speech-in', 'ears'], ['speech-out', 'voice'], ...(decide ? [/** @type {[string, string]} */ (['decide', 'd-model'])] : [])];
  for (const [role, model] of roles) {
    await page.getByLabel(`Add a model to ${role}`).selectOption({ label: model });
    await page.getByRole('button', { name: `Add to ${role}` }).click();
    await expect(page.getByLabel(`Add a model to ${role}`).locator('option', { hasText: model })).toHaveCount(0);
  }
  await page.locator('.voice-chip').click();
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
  await expect(page.locator('.voice-chip')).toHaveText('Voice on');
}

test('cutting her off: a tap stops her mid-sentence and listens; she hears where she was stopped (spec §10.4)', async ({ page }) => {
  const server = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Bixby Bridge is two miles ahead. It opened in 1932, and it was one of the tallest bridges of its kind.' } }])),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'The beach it is.' } }, { name: 'sleep', input: {} }])),
    ],
    '/ears/audio/transcriptions': json({ text: 'Tell me about the beach instead.' }),
    '/voice/audio/speech': longWav(3),
  });
  try {
    await fakeMicrophone(page, [clipPath('where-lunch')]);
    await setUpVoice(page, server.origin);
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('What is ahead?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const label = page.locator('.talk-label');
    await expect(label).toHaveText('Tap to interrupt', { timeout: 20_000 });
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect(label).toHaveText('Tap to talk', { timeout: 30_000 });
    const [, second] = server.bodies('/b/v1/messages');
    const answer = JSON.stringify(second.messages.at(-1));
    expect(answer).toContain('The user stopped you after:');
    expect(answer).toContain('Tell me about the beach instead.');
    expect(await page.evaluate(() => /** @type {any} */ (window).__micOpens)).toBe(1);
  } finally {
    await server.stop();
  }
});

test('chatter: with a quick-decision model, talk that is not for her is recorded, and she sleeps (spec §10.4)', async ({ page }) => {
  const server = await startModelServer({
    '/b/v1/messages': [sse(anthropicToolReply([{ name: 'speak', input: { text: 'Bixby Bridge is two miles ahead.' } }])), sse(anthropicToolReply([{ name: 'sleep', input: {} }]))],
    '/d/v1/messages': sse(anthropicToolReply([{ name: 'decide', input: { option: 'B' } }])),
    '/ears/audio/transcriptions': json({ text: 'Can you pass the water?' }),
    '/voice/audio/speech': wav,
  });
  try {
    await fakeMicrophone(page, [clipPath('gas-station')]);
    await setUpVoice(page, server.origin, { decide: true });
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('What is ahead?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const label = page.locator('.talk-label');
    await expect(label).not.toHaveText('Tap to talk');
    await expect(label).toHaveText('Tap to talk', { timeout: 30_000 });
    expect(server.bodies('/b/v1/messages')).toHaveLength(1);
    expect(JSON.stringify(server.bodies('/d/v1/messages')[0].messages)).toContain('Can you pass the water?');
    await expect(page.locator('.convo .system-line').filter({ hasText: 'Heard, not for Shiori' })).toHaveText('Heard, not for Shiori: Can you pass the water?');
  } finally {
    await server.stop();
  }
});
```

Run both in Chromium: `npx playwright test test/e2e/voice-talk.spec.js --project=chromium`
Expected: PASS (they pin the whole milestone end to end; if one fails, find the cause with superpowers:systematic-debugging before changing anything).

The chatter test's "Heard, not for Shiori" line comes from a `heard` event that is both an answer and dismissed: the conversation shows every dismissed `heard` event as such (3b, Task 4).

- [ ] **Step 2: Finish the device checklist**

Append to `docs/testing/device-checklist-m3.md`:

```markdown
## Voice modes and the car (milestone 3c)

- [ ] **Auto with headphones.** Voice chip on Auto. Connect AirPods (or any Bluetooth headphones), allow the microphone once (tap Shiori): the chip says "Voice on · headphones". Disconnect them: it says "Voice auto · off".
- [ ] **Auto in the car.** Connect the phone to the car by Bluetooth: the chip says "Voice on · car audio" (or "headphones": note which). Note the name the car shows in Settings → Voice → Test the microphone's device list if it's neither.
- [ ] **Auto can't tell.** Fresh install, microphone not allowed yet: the chip says "Voice auto · off". Choose On, then Auto: "Voice on · your last choice".
- [ ] **A hands-free exchange in the car** (the milestone's "Done when"), on both phones, phone in its holder, music playing: tap Shiori once and talk; she answers aloud and listens; answer her; go on for three or four turns without touching the phone. Note: does the music duck or stop while she speaks? Does it come back? Is the car's microphone used (car Bluetooth quality while the microphone is open)? Is she loud enough over road noise? Does the end of your sentence get cut off, or does she wait too long (Settings → Voice → the pause)?
- [ ] **CarPlay and Android Auto.** With Maps on the car's screen and annai on the phone: the exchange still works; directions keep speaking; note what the car shows while Shiori speaks (her clip as "now playing"?).
- [ ] **Split screen with Maps (Android).** annai and Maps side by side: tap Shiori, talk, and she answers.
- [ ] **Steering-wheel buttons (experiment).** With voice on and after she has spoken once, press play/pause (or next track) on the steering wheel or headset: does it tap Shiori (stop her, or start listening)? Note what each button does on each phone.
- [ ] **The first tap on iPhone.** Close annai fully and open it from the Home Screen. Before tapping anything else, let a reply come without a tap (a reminder, once milestone 5 has them; for now, send a message with the keyboard's return key): does she speak, or does a card ask for a tap?
- [ ] **Dictation in the installed app on iPhone.** Speech in: Phone dictation first, no transcription model. In Safari and in the installed app: does dictation hear you? If it fails, does recording take over (with a transcription model second)?
- [ ] **Interrupting and chatter in the car,** as in 3b's list, with road noise.
- [ ] **Show what she's saying.** While she speaks, a passenger taps "Show what she's saying": her words show above the dock.
```

- [ ] **Step 3: Update the README**

In `README.md`, change the status paragraph's "and search and directions links. Voice (milestone 3) is next." to "and search and directions links. And voice: Shiori speaks (OpenAI-compatible voices, or the phone's own) and listens (recording with an end-of-sentence detector, a transcription model or the model itself, or phone dictation), with interruptions, a quick check that talk is meant for her, and Auto, On and Off." and add, after "## Plan and bookings" section:

```markdown
## Voice

- Tap Shiori and talk. With voice on she answers aloud, sentence by sentence as she writes, then listens for your answer; tap her while she speaks to cut her off.
- Voices and transcription are lists you order in Settings → Models: OpenAI-compatible voices and transcription (OpenAI, Groq, local servers), "Send audio to the model" for models that take audio, phone dictation, and the browser's own voice.
- The voice chip on the dock: Auto (on in the car or with headphones), On or Off. What the microphone hears leaves the phone only when someone spoke, only to the entry you chose, and the sound is let go once written down unless you keep voice clips.
```

and add `-m3.md` to the device checklist sentence at the end of "Develop".

- [ ] **Step 4: Run everything**

Run: `npm run stamp && npm run check 2>&1 | tail -4`
Expected: pass.
Run: `npx playwright test --project=chromium 2>&1 | tail -4`
Expected: all pass.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --project=webkit 2>&1 | tail -4`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add test/e2e docs README.md sw.js && git commit -m "Milestone 3 done: a spoken exchange, an interruption and chatter end to end in both browsers, and the device checklist for the car

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
