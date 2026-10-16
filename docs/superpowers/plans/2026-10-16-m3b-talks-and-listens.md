# Milestone 3b: Shiori Talks and Listens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With voice on, Shiori speaks and listens:
- **`speak` plays as it streams, then listens** (spec §7.1, §10.1): sentences play while the model is still writing; the result is what the user said, where they stopped her plus what they said, or "heard nothing" after a silence (8 s by default). `sleep` in the same reply stops `speak` from listening.
- **`wait` listens; `ask` is also spoken** and takes a tap or a spoken answer (§7.1).
- **Listening sessions** (§10.2): recording through the microphone and the detector, or phone dictation; when dictation fails, recording takes over from the next segment.
- **Speech-in list resolution** (§10.3), for every model attempt of any role, against the model receiving the speech: "Send audio to the model" when it takes audio, a transcription model's words (each segment transcribed once per model), or dictation's words. Segments stay in memory until the turn that used them succeeds; then their text versions are written, and the audio is dropped unless "keep voice clips" is on.
- **Turn-taking** (§10.4, §6.1): the microphone keeps recording while a model call runs; what is heard meanwhile reaches her as "heard while you were thinking"; nothing heard is lost; speaking and listening never overlap; tapping her while she speaks stops her, keeps the cut-off point, and opens the microphone; tapping her while she sleeps starts listening.
- **The quick-decision gate** (§10.4): with a quick-decision model configured, what is heard is checked first: for Shiori → the main model; chatter → recorded, and she sleeps; unsure → the main model.

**Architecture:**
- **The provider layer** learns two parts: `audio` (sent to a model that takes audio, as `input_audio` in Chat Completions) and `speech` (a heard segment, resolved per model attempt by a hook `callRole` calls). `callRole` also tells the stream's listener when it starts over on another model (`restart`), so speech streamed by a failed attempt stops.
- **`src/core/voice/resolve.js`** (pure): heard segments in memory, how to listen (recording or dictation), resolution for one model, and lazy text versions.
- **`src/core/voice/listening.js`**: a listening session over the device's microphone or dictation.
- **`src/core/voice/gate.js`** (pure): the gate's question.
- **The agent loop** (`src/core/agent/loop.js`) owns the listening window ("the ear"): who opened it (a tap, or the turn), the silence timer, what each heard segment answers or wakes, the gate, and the end of the turn. `src/core/agent/listen.js` has the words its tools return.
- **The log:** `heard` (a segment: its length, where it came from, what it answered, a kept clip) and `heard.text` (its words, once written down). The transcript holds `speech` parts that get their words from `heard.text`.

**Tech Stack:** as 3a: native ES modules, zero runtime dependencies, JSDoc types checked by TypeScript 6.0.3; `node:test` (Node 26); Playwright 1.63.0 (Chromium; WebKit in Docker).

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`: §6.1 (wakes: speech heard while she was thinking), §6.2 (sleeping means the microphone is off), §6.3 (the now block's voice mode), §7.1 (speak, ask, wait, sleep), §9.6 (a tighter first-output limit for voice; resolution per attempt), §9.7 (quick decision), §10.1–10.4, §16.3 (Listening, Hearing you, Talking).

**Not in this plan (3c has it):** voice mode Auto with its detection, the voice chip, the dock's voice layout, "Show what she's saying" and spoken bubbles kept hidden, the steering-wheel buttons, the remaining end-to-end tests and the device checklist. Until 3c, the voice mode setting is On or Off (Auto counts as Off).

## Choices this plan makes (please check them)

1. **A segment sent as audio is written down when the turn that used it succeeds**, before its audio is dropped (§10.3 asks for it "lazily", "only when something text-only first needs it": every later turn sends the conversation again, and from then on only text can carry those words). A transcript made during the turn (for a text-only model) is reused, so the usual case costs nothing extra.
2. **"Send audio to the model" can write words down:** the model that heard the audio is asked for a verbatim transcript, one short call. The audio goes nowhere it hadn't already gone. Without this, a user with an audio model and no transcription model would see Shiori forget what they said one turn later. The words are marked as written by that model. *Cost if wrong:* one small extra call per spoken segment, only when no transcription model is in the list.
3. **No gate for the first thing said after a tap** on Shiori: tapping her is talking to her. The gate checks everything else heard: answers after `speak`, `wait` and `ask`, and speech while she thinks.
4. **"Chatter → record it and sleep" ends the turn without a model call,** and closes the microphone (sleeping means the microphone is off, §6.2). The chatter is in the transcript, so she knows. Chatter heard while she is thinking is written in at her next step and wakes nothing. During an `ask`, chatter is recorded and the buttons keep waiting.
5. **What was heard is shown in the conversation as your bubble, in words,** so you can see what annai understood. (Her spoken words being hidden unless asked is 3c's.)
6. **A spoken answer is never taken from before she spoke.** Speech queued while she was thinking reaches her as "heard while you were thinking", not as the answer to the `speak` that followed it. (A typed message still answers, as before.)
7. **An `ask`'s question is spoken whole when the tool runs,** not streamed; listening for its answer stops after the silence limit, and the buttons keep waiting.
8. **When a model attempt fails partway through a `speak`, what it had started saying stops**; the next model's `speak` plays whole. The user may hear a sentence twice. (§9.6's "said so far" note is for text.)
9. **Time limits in voice:** Shiori's first words must start within 15 s with voice on (the main role's own limit if lower), §9.6's "tighter for voice"; the silence after `speak` is 8 s (§7.1), both in Settings → Voice.
10. **Settings → Voice gets** the voice mode (Auto, On, Off; Auto works in 3c), "Listen for an answer (seconds)", "Wait for her first words (seconds)" and "Keep voice clips" (off by default, §10.2).
11. **The microphone's errors are explained by the core,** in the same plain words as Settings → Voice: `micProblem` moves to `src/core/voice/mic.js`, and the UI passes which phone it is.

## Global Constraints

- All of 3a's Global Constraints hold (`docs/superpowers/plans/2026-10-16-m3a-voice-parts.md`).
- **"Audio leaves the phone only when speech was detected, and only to the configured speech-in entry. Transcripts go into the log. Audio is discarded unless the user turns on 'keep voice clips'" (§10.2).** A kept clip is a blob named by its `heard` event's refs (§4.9).
- **"Sleeping means the microphone is off" (§6.2).** No listening window outlives a turn, except one the user opened with a tap, until its first segment or its silence limit.
- **"Speaking and listening never overlap (half-duplex)" (§10.4).** The microphone closes before her voice plays.
- **"Every speak call gets a recorded result even if the loop ends without the main model seeing it" (§7.1).**
- **"It runs only when a quick-decision model is configured, because falling back to the main model would double the calls" (§10.4).**
- **"Each segment stays in memory until the turn that used it succeeds. Transcripts are cached per segment and per ASR model. A failed ASR model is benched like any other model" (§10.3).**
- **"Dictation is exclusive. If phone dictation is the first usable entry, segments arrive as text only … If dictation fails, listening switches to recording from the next segment" (§10.3).**
- **"With no usable entry … the mic button explains what to add" (§10.3).**
- **Audio session types** (§10.1): `transient` while speaking, `play-and-record` while listening, `playback` afterwards.
- **Copy:** plain words; system cards are never in Shiori's voice; every error says what happened and what to do next.
- **Commit:** `npm run stamp && npm run check` must pass before every commit, chained with `&&`; after `plugins-official/` changes, `npm run catalog` first. Messages end with the two attribution lines.

## Review Focus

1. **A turn that fails after hearing speech** (no model answers): the segment stays in memory; the user's next attempt still carries their words; nothing is written as "[audio, not transcribed]" while the audio exists. Pinned in Task 6.
2. **Speech that arrives at the edges:** the user starts talking just as she starts speaking (the microphone closes mid-sentence), or right as the turn ends with `sleep`. Each becomes a segment and reaches her; nothing is dropped and no turn starts twice. Pinned in Task 6.
3. **The tap at every moment:** while she speaks with the reply still streaming, while she listens, while she thinks, while she sleeps, during an `ask`. Each does what §10.4 and §6.7 say, and every `speak` still gets a result. Pinned in Tasks 5 and 6.
4. **A transcription model that fails or rests:** the next entry hears it; a text-only model with nothing to hear the speech is skipped like any capability gap; the card names what to add. Pinned in Tasks 2 and 6.
5. **The gate's model is down, slow, or unsure:** the speech goes to the main model; the gate never loses speech. Pinned in Task 7.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/core/llm/contract.js`, `fallback.js`, `service.js`, `decide.js` | 1 | `audio` and `speech` parts; resolution per attempt; `restart`; `no-audio`; `llm.gate` |
| `plugins-official/chat-completions/index.js`, `plugins-official/scripted-model/index.js` | 1 | audio as `input_audio`; scripted tool arguments that stream |
| `src/core/voice/resolve.js` | 2 | `HeardMemory`, `listenKind`, `resolveSpeech`, `textVersion` |
| `src/core/voice/listening.js`, `src/core/voice/voice.js`, `src/core/voice/settings.js`, `src/core/voice/mic.js`, `src/ui/mic-help.js` | 3 | listening sessions; the Voice's listening, resolver, writing down, mode |
| `src/core/agent/transcript.js`, `compaction.js`, `self-tools.js`, `src/ui/screens/talk.js`, `src/ui/screens/trace.js` | 4 | `heard` and `heard.text` in the conversation, housekeeping, recall, the screens |
| `src/core/agent/loop.js`, `src/core/agent/listen.js`, `src/core/agent/tools.js`, `src/core/agent/instructions.js`, `src/core/agent/context.js` | 5, 6, 7 | speaking, listening and the gate in the loop |
| `src/core/voice/gate.js` | 7 | the gate's question |
| `src/ui/dock.js`, `src/ui/screens/voice.js`, `src/app/main.js`, `test/e2e/voice-talk.spec.js` | 8 | the tap, the glow, the settings, the spoken exchange end to end |
| `test/unit/agent-kit.js`, `test/unit/voice-fakes.js` | 5 | an agent with voice, for the tests |

---
### Task 1: Audio and heard speech in the provider layer

**Files:**
- Modify: `src/core/llm/contract.js`, `src/core/llm/fallback.js`, `src/core/llm/service.js`, `src/core/llm/decide.js`, `src/ui/format.js`, `plugins-official/chat-completions/index.js` (+ `annai-plugin.json` 0.3.0), `plugins-official/scripted-model/index.js` (+ `annai-plugin.json` 0.3.0), `catalog/plugins.json` (by `npm run catalog`)
- Test: `test/unit/llm-speech-parts.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks of this plan.
- Produces:
  - `Part` gains `{ type: 'audio', mediaType: string, data: string }` (base64) and `{ type: 'speech', id: string, text?: string, clip?: string }` (a heard segment; `text` once its words are written down; `clip` a kept clip's hash).
  - `StreamEvent` gains `{ type: 'restart' }`: `callRole` sends it before every attempt after the first.
  - `portable()` turns any `speech` part left unresolved into text (its words, or `[audio, not transcribed]`).
  - `gap(model, request)` returns `'no-audio'` for audio and a model without `'audio'` input.
  - `callRole({ …, speech? })`: `speech(model, request): Promise<Request>` resolves heard speech before each attempt; a throw skips that model with outcome `'no-speech'` and the error's message.
  - `llm.call({ …, speech?, firstOutputMs? })` passes both to `callRole`.
  - `decide({ …, parts?, fallback? })`: `parts` follow the question; with `fallback: false`, a result below the threshold (or none) is `{ probabilities, by: 'unsure' }` and the main model isn't asked.
  - `llm.gate({ prompt, options, parts?, speech?, scope?, threshold? }): Promise<{ probabilities, by: 'decide' | 'unsure' }>`, logged as a `decide` event with `gate: true`.
  - Chat Completions sends `audio` parts as `{ type: 'input_audio', input_audio: { data, format } }`; its model list keeps `'audio'` input.
  - The scripted model: a step with `stream: true` gives each tool call's arguments as `tool_input` events (8 characters more each, `pieceMs` apart) before the `tool_call`; with `breakAt: n`, the connection drops after n of them (a `network` error).

- [ ] **Step 1: Write the failing test**

`test/unit/llm-speech-parts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callRole, Bench, gap } from '../../src/core/llm/fallback.js';
import { portable, ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { decide } from '../../src/core/llm/decide.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { modelOf } from '../../src/core/llm/config.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';
import { activate as chat } from '../../plugins-official/chat-completions/index.js';

const helpers = { sse, parsePartialJSON, ProviderError, errorFromResponse, retry };
/** @param {(annai: any) => any} activate @returns {any} */
function typeOf(activate) {
  /** @type {any} */
  let t = null;
  activate({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'p' }; return () => {}; } }, helpers });
  return t;
}
const scriptedType = typeOf(scripted);

/** Scripted models in the main role, in order, each taking the inputs given. @param {{ script: any[], input: string[] }[]} list @returns {any} */
function config(list) {
  /** @type {any} */
  const cfg = { endpoints: {}, models: {}, roles: { main: { models: [], level: 'off' } } };
  list.forEach(({ script, input }, i) => {
    cfg.endpoints[`ep-${i}`] = { id: `ep-${i}`, type: 'scripted', template: null, user: { name: `E${i}`, tunables: { script } }, created: 0 };
    cfg.models[`m-${i}`] = { id: `m-${i}`, endpoint: `ep-${i}`, template: null, user: { providerId: `model-${i}`, input }, created: 0 };
    cfg.roles.main.models.push(`m-${i}`);
  });
  return cfg;
}
/** @type {any} */
const heardRequest = { messages: [{ role: 'user', parts: [{ type: 'text', text: '[heard]' }, { type: 'speech', id: 's-1' }] }] };
/** Audio for a model that takes it, the words for one that doesn't. @param {any} model @param {any} request */
const resolve = async (model, request) => ({
  ...request,
  messages: request.messages.map((/** @type {any} */ m) => ({
    role: m.role,
    parts: m.parts.map((/** @type {any} */ p) => (p.type !== 'speech' ? p : model.input.includes('audio') ? { type: 'audio', mediaType: 'audio/wav', data: 'UklGRg==' } : { type: 'text', text: 'where should we eat' })),
  })),
});

test('heard speech is resolved again for every model attempt, against the model receiving it (spec §10.3)', async () => {
  const cfg = config([
    { script: [{ error: 'credit', status: 402 }], input: ['text', 'audio'] },
    { script: [{ error: 'auth', status: 401 }], input: ['text'] },
    { script: [{ text: 'ok' }], input: ['text', 'audio'] },
  ]);
  /** @type {string[][]} */
  const received = [];
  const watched = { ...scriptedType, run: (/** @type {any} */ c) => { received.push(c.request.messages[0].parts.map((/** @type {any} */ p) => p.type)); return scriptedType.run(c); } };
  /** @type {string[]} */
  const events = [];
  const r = await callRole({ role: 'main', request: heardRequest, config: cfg, types: new Map([['scripted', watched]]), keyFor: async () => null, bench: new Bench(), sleep: async () => {}, speech: resolve, onEvent: (e) => events.push(e.type) });
  assert.equal(r.reply.text, 'ok');
  assert.deepEqual(received, [['text', 'audio'], ['text', 'text'], ['text', 'audio']]);
  assert.equal(events.filter((t) => t === 'restart').length, 2, 'the stream listener hears each time a call starts over');
});

test('a model nothing in the speech-in list can reach is skipped as "no-speech"; the next one answers', async () => {
  const cfg = config([{ script: [{ text: 'never' }], input: ['text'] }, { script: [{ text: 'ok' }], input: ['text', 'audio'] }]);
  const r = await callRole({
    role: 'main', request: heardRequest, config: cfg, types: new Map([['scripted', scriptedType]]), keyFor: async () => null, bench: new Bench(),
    speech: async (model, request) => {
      if (!model.input.includes('audio')) throw new Error(`nothing in the speech-in list can hear it for ${model.name}`);
      return resolve(model, request);
    },
  });
  assert.equal(r.reply.text, 'ok');
  assert.deepEqual(r.attempts.map((a) => [a.outcome, a.error ?? '']), [['no-speech', 'nothing in the speech-in list can hear it for model-0'], ['ok', '']]);
});

test('audio goes only to a model that takes audio, and speech never reaches a provider unresolved', () => {
  const model = modelOf({ id: 'm', endpoint: 'e', template: null, user: { providerId: 'x', input: ['text'] }, created: 0 });
  /** @type {any} */
  const withAudio = { messages: [{ role: 'user', parts: [{ type: 'audio', mediaType: 'audio/wav', data: 'AA==' }] }] };
  assert.equal(gap(model, withAudio), 'no-audio');
  assert.equal(gap({ ...model, input: ['text', 'audio'] }, withAudio), null);
  /** @type {any} */
  const messages = [{ role: 'user', parts: [{ type: 'speech', id: 's-1', text: 'hi there' }, { type: 'speech', id: 's-2' }, { type: 'audio', mediaType: 'audio/wav', data: 'AA==' }] }];
  assert.deepEqual(portable(messages, 'x')[0].parts, [{ type: 'text', text: 'hi there' }, { type: 'text', text: '[audio, not transcribed]' }, { type: 'audio', mediaType: 'audio/wav', data: 'AA==' }]);
});

test('a decision can carry heard speech; without a fallback, an unsure answer stays unsure (spec §10.4)', async () => {
  /** @type {any[]} */
  const asked = [];
  const call = async (/** @type {string} */ role, /** @type {any} */ request) => {
    asked.push([role, request.messages[0].parts.map((/** @type {any} */ p) => p.type)]);
    return { reply: { parts: [], text: 'B', logprobs: [{ token: 'A', logprob: Math.log(0.45) }, { token: 'B', logprob: Math.log(0.55) }] } };
  };
  const options = [{ id: 'shiori', label: 'For Shiori' }, { id: 'chatter', label: 'Not for her' }];
  const r = await decide({ prompt: 'Is it for her?', options, call, logprobs: true, parts: [{ type: 'speech', id: 's-1' }], fallback: false });
  assert.equal(r.by, 'unsure');
  assert.ok(Math.abs(r.probabilities.chatter - 0.55) < 1e-9);
  assert.deepEqual(asked, [['decide', ['text', 'speech']]], 'the main model was not asked');
  const sure = await decide({ prompt: 'Is it for her?', options, call: async () => ({ reply: { parts: [], text: 'A', logprobs: [{ token: 'A', logprob: Math.log(0.9) }] } }), logprobs: true, fallback: false });
  assert.equal(sure.by, 'decide');
});

test('Chat Completions sends audio as input_audio, after the tool results it answers; its list keeps audio input', () => {
  const type = typeOf(chat);
  const endpoint = { id: 'ep', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: {}, tunables: { ...type.tunables }, extraBody: {} };
  const model = { id: 'm', name: 'Flash', providerId: 'google/gemini-flash', input: ['text', 'audio'], tools: true, maxOutput: null, tunables: {}, extraBody: {} };
  const { body } = type.build({
    endpoint, model, key: 'k', tunables: { ...type.tunables },
    request: { messages: [
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'speak', input: { text: 'Want tacos?' } }] },
      { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'The user said:' }, { type: 'audio', mediaType: 'audio/wav', data: 'UklGRg==' }] },
    ] },
  });
  assert.deepEqual(body.messages.slice(-2), [
    { role: 'tool', tool_call_id: 'c1', content: 'The user said:' },
    { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } }] },
  ]);
  assert.deepEqual(type.readList({ data: [{ id: 'g', architecture: { input_modalities: ['text', 'image', 'audio'] } }] })[0].input, ['text', 'image', 'audio']);
});

test("the scripted model can stream a tool call's arguments, as real endpoints do", async () => {
  const text = 'Bixby Bridge is two miles ahead. Want to stop?';
  const endpoint = { id: 'ep-s', type: 'scripted', name: 'S', baseUrl: '', headers: {}, tunables: { script: [{ stream: true, toolCalls: [{ name: 'speak', input: { text } }] }] }, extraBody: {} };
  /** @type {any[]} */
  const events = [];
  for await (const e of scriptedType.run({ endpoint, model: {}, key: null, tunables: {}, request: { messages: [] } })) events.push(e);
  const partials = events.filter((e) => e.type === 'tool_input');
  assert.ok(partials.length > 3);
  assert.equal(parsePartialJSON(partials[2].partial)?.text, 'Bixby Bridge is');
  assert.deepEqual(JSON.parse(partials.at(-1).partial), { text });
  const call = events.findIndex((e) => e.type === 'tool_call');
  assert.equal(events[call].input.text, text);
  assert.equal(events[call].id, partials[0].id);
  assert.ok(call > events.findIndex((e) => e.type === 'tool_input'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/llm-speech-parts.test.js`
Expected: FAIL: the first test's `received` shows `speech` parts reaching the model (no resolution), and `gap` returns `null` for audio.

- [ ] **Step 3: Write the implementation**

In `src/core/llm/contract.js`, add to the `Part` union (after the `document` line):

```js
 *   | { type: 'audio', mediaType: string, data: string }
 *   | { type: 'speech', id: string, text?: string, clip?: string }
```

and to its description: "audio.data is base64, sent only to a model that takes audio. speech is a heard segment (spec §10.3): annai resolves it for each model attempt into audio or words; text is its words once written down, clip a kept voice clip's hash." Add to the `StreamEvent` union:

```js
 *   | { type: 'restart' }
```

with: "restart: annai starts over, on another model or the same one; what streamed before is void (only callRole sends it)". In `portable`, add as the first line of `keep`:

```js
    if (p.type === 'speech') return [{ type: 'text', text: p.text || '[audio, not transcribed]' }]; // resolved before sending; never sent as it is
```

In `src/core/llm/fallback.js`:
- in `gap`, after the `no-images` line:

```js
  if (request.messages.some((m) => m.parts.some((p) => p.type === 'audio')) && !model.input.includes('audio')) return 'no-audio';
```

- in `callRole`'s JSDoc, add `speech?: (model: Model, request: Request) => Promise<Request>` to the parameter type, with: "speech: resolves heard speech for the model about to be called (spec §10.3); a throw means nothing in the speech-in list can reach it, and the model is skipped";
- before `for (const id of ordered) {` add `let began = false;`
- replace the start of the retry loop:

```js
    for (let retry = 0; ; retry++) {
      const started = now();
      try {
        const reply = await callOnce({
          type, endpoint, model, key, request, level, fetch: c.fetch, signal: c.signal, onEvent: c.onEvent,
```

with:

```js
    for (let retry = 0; ; retry++) {
      // Heard speech is resolved against the model actually receiving it, at every attempt (spec §10.3).
      let sendable = request;
      if (c.speech) {
        try {
          sendable = await c.speech(model, request);
        } catch (e) {
          attempts.push({ model: id, name: model.name, outcome: 'no-speech', ms: 0, error: String(/** @type {any} */ (e)?.message ?? e) });
          break;
        }
      }
      if (began) c.onEvent?.({ type: 'restart' });
      began = true;
      const started = now();
      try {
        const reply = await callOnce({
          type, endpoint, model, key, request: sendable, level, fetch: c.fetch, signal: c.signal, onEvent: c.onEvent,
```

In `src/core/llm/service.js`, add `speech` and `firstOutputMs` to `call`'s parameter (typedef: `speech?: Parameters<typeof callRole>[0]['speech'], firstOutputMs?: number`) and pass both to `callRole`. Add after `decide`:

```js
    /**
     * The quick-decision gate (spec §10.4): one decision whose question may carry heard speech,
     * and no fallback to the main model: below the threshold the answer is 'unsure'.
     * @param {{ prompt: string, options: { id: string, label: string }[], parts?: import('./contract.js').Part[], speech?: Parameters<typeof callRole>[0]['speech'],
     *   scope?: string, threshold?: number }} c
     */
    async gate({ prompt, options, parts, speech, scope = SYS, threshold }) {
      const cfg = await readConfig(ws);
      const firstId = cfg.roles.decide?.models?.[0];
      const first = firstId && cfg.models[firstId] ? modelOf(cfg.models[firstId]) : null;
      const call = (/** @type {string} */ role, /** @type {any} */ request) => service.call({ role, request, scope, speech, record: { tag: 'gate' } });
      const r = await decideWith({ prompt, options, threshold, call, logprobs: Boolean(first?.logprobs), parts, fallback: false });
      await logEvent(store, scope, { type: 'decide', data: { prompt: prompt.slice(0, 500), options: options.map((o) => o.id), result: r.probabilities, by: r.by, gate: true } }).catch(() => {});
      return r;
    },
```

In `src/core/llm/decide.js`:
- the parameter typedef gains `parts?: import('./contract.js').Part[], fallback?: boolean` ("parts: more of the question, such as heard speech; fallback false: below the threshold, or with no readable answer, the result is 'unsure' and the main model isn't asked"), and the return type's `by` gains `'unsure'`;
- `export async function decide({ prompt, options, threshold = DECIDE_THRESHOLD, call, logprobs = false, parts = [], fallback = true })`;
- the messages line becomes `const messages = [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text }, ...parts] }];`
- after `if (spread && Math.max(...spread) >= threshold) return …;` add:

```js
  if (!fallback) return { probabilities: spread ? byId(options, spread) : {}, by: 'unsure' };
```

In `src/ui/format.js`, add to `OUTCOMES`: `'no-speech': "couldn't hear the speech", 'no-audio': "doesn't take audio",`.

In `plugins-official/chat-completions/index.js`:
- add `const AUDIO = /** @type {Record<string, string>} */ ({ 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/aac': 'aac' });` after `CODES`;
- in `wire`, the `rest` filter becomes `p.type === 'text' || p.type === 'image' || p.type === 'document' || p.type === 'audio'`, and in the map, before the `image_url` return:

```js
      if (p.type === 'audio') return { type: 'input_audio', input_audio: { data: p.data, format: AUDIO[p.mediaType] ?? 'wav' } };
```

- in `readList`, `out.input = ['text', 'image', 'audio'].filter((k) => kinds.includes(k));`
- the module comment gains: "Audio a model takes goes as input_audio (OpenRouter, Gemini, OpenAI's audio models)."
- `annai-plugin.json`: `"version": "0.3.0"`.

In `plugins-official/scripted-model/index.js`, replace the tool-call loop with:

```js
      for (const [i, c] of toolCalls.entries()) {
        const id = `scripted_${n}_${i}`;
        if (step.stream) {
          // The arguments as they would stream, 8 characters more each time.
          const json = JSON.stringify(c.input ?? {});
          let pieces = 0;
          for (let at = 8; at < json.length + 8; at += 8) {
            if (step.pieceMs) await sleep(step.pieceMs, signal);
            if (step.breakAt !== undefined && pieces++ >= step.breakAt) throw new ProviderError('network', 'The scripted connection dropped.');
            yield { type: 'tool_input', id, name: c.name, partial: json.slice(0, at) };
          }
        }
        yield { type: 'tool_call', id, name: c.name, input: c.input ?? {} };
      }
```

and add to its comment: "stream: true gives each tool call's arguments as tool_input events first, pieceMs apart; breakAt: n drops the connection after n of them." `annai-plugin.json`: `"version": "0.3.0"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run catalog && node --test test/unit/llm-speech-parts.test.js test/unit/llm-chat-completions.test.js test/unit/llm-fallback.test.js test/unit/llm-decide.test.js`
Expected: PASS. (If a chat-completions list test expected `input: ['text', 'image']` for a fixture model whose modalities include audio, the new value is right: update that expectation and say so in the commit.)

- [ ] **Step 5: Commit**

```bash
npm run catalog && npm run stamp && npm run check && git add src/core/llm src/ui/format.js plugins-official catalog test/unit sw.js && git commit -m "Heard speech in the provider layer: resolved for each model attempt, audio as input_audio, and a gate that never falls back (spec §9.6, §10.3, §10.4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 2: Speech-in list resolution

**Files:**
- Create: `src/core/voice/resolve.js`
- Modify: `sw.js`
- Test: `test/unit/voice-resolve.test.js`

**Interfaces:**
- Consumes: `Part`, `Request` (Task 1), `toBase64` (`src/core/bytes.js`).
- Produces:
  - `Heard = { id, source: 'mic' | 'dictation', audio?: { data: Uint8Array, mediaType, seconds }, text?: string, ms, at }`; `Kept = Heard & { transcripts: Map<string, string> }`.
  - `NOT_TRANSCRIBED = '[audio, not transcribed]'`.
  - `class HeardMemory { keep(h: Heard); get(id): Kept | null; drop(id); get size(): number }`.
  - `listenKind({ list, model, asr, dictation }): { kind: 'record' | 'dictation' } | { kind: null, why: string }`.
  - `resolveSpeech(request, model: { name, input }, c: Resolve): Promise<Request>`, throwing `nothing in the speech-in list can hear it for <model>`; `Resolve = { list, memory, asr(id), transcribe(id, kept), clip?(hash), onFail?(id, error) }`.
  - `textVersion(kept, c: Resolve & { hearer?(kept): Promise<string> }): Promise<{ text, by } | null>` (`by`: `'dictation'`, `'send-audio'`, or a model id).

- [ ] **Step 1: Write the failing test**

`test/unit/voice-resolve.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeardMemory, listenKind, resolveSpeech, textVersion, NOT_TRANSCRIBED } from '../../src/core/voice/resolve.js';

const enc = new TextEncoder();
/** @param {string} name @param {string[]} input */
const model = (name, input) => ({ name, input });
/** @param {string} id @param {any} [more] @returns {any} */
const segment = (id, more = {}) => ({ id, source: 'mic', audio: { data: enc.encode(`RIFF-${id}`), mediaType: 'audio/wav', seconds: 1.5 }, ms: 1500, at: 0, ...more });
/** @param {any[]} parts @returns {any} */
const asked = (parts) => ({ messages: [{ role: 'user', parts }] });
const partsOf = (/** @type {any} */ r) => r.messages[0].parts;

/** What resolution needs: the speech-in list, and transcription models that answer or fail. @param {HeardMemory} memory @param {{ failing?: string[] }} [o] */
function deps(memory, { failing = [] } = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const failed = [];
  const c = {
    list: ['send-audio', 'asr-a', 'asr-b', 'dictation'], memory,
    asr: (/** @type {string} */ id) => id.startsWith('asr-') && !failed.includes(id),
    transcribe: async (/** @type {string} */ id, /** @type {any} */ kept) => {
      calls.push(`${id} ${kept.id}`);
      if (failing.includes(id)) throw new Error(`${id} is down`);
      return `words of ${kept.id} by ${id}`;
    },
    clip: async (/** @type {string} */ hash) => (hash === 'h-kept' ? enc.encode('RIFF-kept') : null),
    onFail: (/** @type {string} */ id) => { failed.push(id); },
  };
  return { c, calls, failed };
}

test("the spec's example: M1 (audio) → M2 (text only) → M3 (audio); ASR-A runs once however many need it (spec §10.3)", async () => {
  const memory = new HeardMemory();
  memory.keep(segment('s-1'));
  const { c, calls } = deps(memory);
  const req = asked([{ type: 'text', text: '[heard]' }, { type: 'speech', id: 's-1' }]);
  assert.deepEqual(partsOf(await resolveSpeech(req, model('M1', ['text', 'audio']), c))[1], { type: 'audio', mediaType: 'audio/wav', data: Buffer.from('RIFF-s-1').toString('base64') });
  assert.deepEqual(partsOf(await resolveSpeech(req, model('M2', ['text']), c))[1], { type: 'text', text: 'words of s-1 by asr-a' });
  assert.equal(partsOf(await resolveSpeech(req, model('M3', ['text', 'audio']), c))[1].type, 'audio');
  await resolveSpeech(req, model('M2', ['text']), c);
  assert.deepEqual(calls, ['asr-a s-1']);
  const typed = asked([{ type: 'text', text: 'typed' }]);
  assert.equal(await resolveSpeech(typed, model('M2', ['text']), c), typed, 'a request with no speech is left as it is');
});

test('a transcription model that fails is benched and the next one hears it; with nothing left, the model is skipped', async () => {
  const memory = new HeardMemory();
  memory.keep(segment('s-1'));
  const { c, failed } = deps(memory, { failing: ['asr-a'] });
  assert.equal(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 's-1' }]), model('M2', ['text']), c))[0].text, 'words of s-1 by asr-b');
  assert.deepEqual(failed, ['asr-a']);
  memory.keep(segment('s-2'));
  const none = deps(memory, { failing: ['asr-a', 'asr-b'] });
  await assert.rejects(resolveSpeech(asked([{ type: 'speech', id: 's-2' }]), model('M2', ['text']), none.c), /nothing in the speech-in list can hear it for M2/);
});

test("dictation's words go to every model; words written down win; a kept clip still works; nothing left is said so", async () => {
  const memory = new HeardMemory();
  memory.keep({ id: 'd-1', source: 'dictation', text: 'is there a gas station', ms: 0, at: 0 });
  const { c } = deps(memory);
  const audio = model('M1', ['text', 'audio']);
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 'd-1' }]), audio, c))[0], { type: 'text', text: 'is there a gas station' });
  memory.keep(segment('s-3'));
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 's-3', text: 'already written' }]), audio, c))[0], { type: 'text', text: 'already written' });
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 's-3', text: '' }]), audio, c))[0], { type: 'text', text: '(nothing clear was said)' });
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 'gone', clip: 'h-kept' }]), audio, c))[0], { type: 'audio', mediaType: 'audio/wav', data: Buffer.from('RIFF-kept').toString('base64') });
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 'lost' }]), audio, c))[0], { type: 'text', text: NOT_TRANSCRIBED });
});

test('how to listen: the first usable entry against the model expected to hear; dictation is exclusive (spec §10.3)', () => {
  const audio = model('M1', ['text', 'audio']);
  const text = model('M2', ['text']);
  const asr = (/** @type {string} */ id) => id === 'asr-a';
  assert.equal(listenKind({ list: ['send-audio', 'dictation'], model: audio, asr, dictation: true }).kind, 'record');
  assert.equal(listenKind({ list: ['send-audio', 'dictation'], model: text, asr, dictation: true }).kind, 'dictation');
  assert.equal(listenKind({ list: ['send-audio', 'asr-a', 'dictation'], model: text, asr, dictation: true }).kind, 'record');
  assert.equal(listenKind({ list: ['dictation', 'send-audio'], model: audio, asr, dictation: true }).kind, 'dictation');
  const none = /** @type {any} */ (listenKind({ list: ['send-audio', 'dictation'], model: text, asr, dictation: false }));
  assert.equal(none.kind, null);
  assert.match(none.why, /M2 doesn't take audio/);
  assert.match(none.why, /Add a transcription model in Settings → Models/);
  assert.match(/** @type {any} */ (listenKind({ list: [], model: null, asr, dictation: true })).why, /speech-in list is empty/);
});

test('text versions: a transcript made already, dictation, the hearing model for sent audio, then the list in order (spec §10.3)', async () => {
  const memory = new HeardMemory();
  memory.keep(segment('s-1'));
  const { c, calls } = deps(memory);
  const one = /** @type {any} */ (memory.get('s-1'));
  one.transcripts.set('asr-b', 'from before');
  assert.deepEqual(await textVersion(one, c), { text: 'from before', by: 'asr-b' });
  assert.deepEqual(await textVersion({ id: 'd', source: 'dictation', text: 'hi', ms: 0, at: 0, transcripts: new Map() }, c), { text: 'hi', by: 'dictation' });
  memory.keep(segment('s-2'));
  const two = /** @type {any} */ (memory.get('s-2'));
  assert.deepEqual(await textVersion(two, { ...c, hearer: async () => 'heard by the model' }), { text: 'heard by the model', by: 'send-audio' });
  assert.deepEqual(await textVersion(two, c), { text: 'words of s-2 by asr-a', by: 'asr-a' });
  assert.deepEqual(calls, ['asr-a s-2']);
  memory.keep(segment('s-4'));
  assert.equal(await textVersion(/** @type {any} */ (memory.get('s-4')), { ...c, list: ['dictation'] }), null);
  memory.drop('s-4');
  assert.equal(memory.get('s-4'), null);
  assert.equal(memory.size, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/voice-resolve.test.js`
Expected: FAIL with `Cannot find module '…/src/core/voice/resolve.js'`

- [ ] **Step 3: Write the implementation**

`src/core/voice/resolve.js`:

```js
import { toBase64 } from '../bytes.js';

/**
 * Speech-in list resolution (spec §10.3). What was heard stays in memory as a segment until the
 * turn that used it succeeds. For each model attempt, of any role, the speech-in list is walked
 * again against the model actually receiving it: "Send audio to the model" when that model takes
 * audio; a transcription model's words, made once per segment; or phone dictation's words, which
 * are all a dictated segment has. Text versions are made lazily (textVersion).
 * @typedef {{ id: string, source: 'mic' | 'dictation', audio?: { data: Uint8Array, mediaType: string, seconds: number }, text?: string, ms: number, at: number }} Heard
 * @typedef {Heard & { transcripts: Map<string, string> }} Kept  a segment in memory, with its words by each transcription model
 * @typedef {import('../llm/contract.js').Request} Request
 * @typedef {import('../llm/contract.js').Part} Part
 * @typedef {{ name: string, input: string[] }} Hearer  the model a request goes to
 * @typedef {{ list: string[], memory: HeardMemory, asr: (id: string) => boolean, transcribe: (id: string, kept: Kept) => Promise<string>,
 *   clip?: (hash: string) => Promise<Uint8Array | null>, onFail?: (id: string, error: unknown) => void }} Resolve
 *   list: the speech-in list; asr: whether an entry is a transcription model that can work now; onFail: one failed (bench it)
 */

/** A segment nothing could write down (spec §10.3). */
export const NOT_TRANSCRIBED = '[audio, not transcribed]';
/** Providers refuse empty text. @param {string} t */
const said = (t) => t.trim() || '(nothing clear was said)';

/** Heard segments in memory, until the turn that used them succeeds (spec §10.3). */
export class HeardMemory {
  /** @type {Map<string, Kept>} */
  #all = new Map();

  /** @param {Heard} h */
  keep(h) {
    if (!this.#all.has(h.id)) this.#all.set(h.id, { ...h, transcripts: new Map() });
  }

  /** @param {string} id @returns {Kept | null} */
  get(id) {
    return this.#all.get(id) ?? null;
  }

  /** @param {string} id */
  drop(id) {
    this.#all.delete(id);
  }

  get size() {
    return this.#all.size;
  }
}

/**
 * How to listen (spec §10.3): the first usable entry of the speech-in list, judged against the
 * model expected to hear it, chooses recording or phone dictation. Dictation is exclusive: when it
 * comes first, segments arrive as text only. With nothing usable, the reason says what to add.
 * @param {{ list: string[], model: Hearer | null, asr: (id: string) => boolean, dictation: boolean }} c  dictation: this browser has it, and it hasn't failed
 * @returns {{ kind: 'record' | 'dictation' } | { kind: null, why: string }}
 */
export function listenKind({ list, model, asr, dictation }) {
  for (const id of list) {
    if (id === 'send-audio') {
      if (model?.input.includes('audio')) return { kind: 'record' };
    } else if (id === 'dictation') {
      if (dictation) return { kind: 'dictation' };
    } else if (asr(id)) {
      return { kind: 'record' };
    }
  }
  if (!list.length) return { kind: null, why: "Shiori can't hear you: the speech-in list is empty. Add an entry in Settings → Models → Speech in." };
  const hearing = model ? `${model.name} doesn't take audio` : 'no main model is set';
  return {
    kind: null,
    why: `Shiori can't hear you yet: ${hearing}, and the speech-in list has no transcription model that works${dictation ? '' : ' (and this browser has no phone dictation)'}. Add a transcription model in Settings → Models, such as OpenAI or Groq, or a main model that takes audio.`,
  };
}

/**
 * The request as one model can take it (spec §10.3): each speech part becomes audio or words.
 * Throws when nothing in the speech-in list can hear a segment for this model, which is then
 * skipped like any capability gap (§9.6).
 * @param {Request} request @param {Hearer} model @param {Resolve} c @returns {Promise<Request>}
 */
export async function resolveSpeech(request, model, c) {
  if (!request.messages.some((m) => m.parts.some((p) => p.type === 'speech'))) return request;
  /** @type {import('../llm/contract.js').Message[]} */
  const messages = [];
  for (const m of request.messages) {
    /** @type {Part[]} */
    const parts = [];
    for (const p of m.parts) parts.push(p.type === 'speech' ? await resolvePart(p, model, c) : p);
    messages.push({ role: m.role, parts });
  }
  return { ...request, messages };
}

/** @param {{ id: string, text?: string, clip?: string }} p @param {Hearer} model @param {Resolve} c @returns {Promise<Part>} */
async function resolvePart(p, model, c) {
  // Words written down already are what every later request sends (spec §10.3).
  if (p.text !== undefined) return { type: 'text', text: said(p.text) };
  if (!c.memory.get(p.id) && p.clip) {
    // A kept voice clip (spec §10.2) stands in for audio that has left memory.
    const data = await c.clip?.(p.clip);
    if (data) c.memory.keep({ id: p.id, source: 'mic', audio: { data, mediaType: 'audio/wav', seconds: 0 }, ms: 0, at: 0 });
  }
  const kept = c.memory.get(p.id);
  if (!kept) return { type: 'text', text: NOT_TRANSCRIBED };
  if (!kept.audio) return { type: 'text', text: said(kept.text ?? '') };
  for (const id of c.list) {
    if (id === 'send-audio') {
      if (model.input.includes('audio')) return { type: 'audio', mediaType: kept.audio.mediaType, data: toBase64(kept.audio.data) };
      continue;
    }
    if (id === 'dictation' || !c.asr(id)) continue; // dictation can't read recorded audio
    const had = kept.transcripts.get(id);
    if (had !== undefined) return { type: 'text', text: said(had) };
    try {
      const text = await c.transcribe(id, kept);
      kept.transcripts.set(id, text);
      return { type: 'text', text: said(text) };
    } catch (e) {
      c.onFail?.(id, e);
    }
  }
  throw new Error(`nothing in the speech-in list can hear it for ${model.name}`);
}

/**
 * A segment's words, for when only text can carry them (spec §10.3, made lazily): a transcript
 * made already, dictation's words, or the first entry of the list that can write it down. "Send
 * audio to the model" writes it down through the model that heard it (hearer). null: nothing could.
 * @param {Kept} kept @param {Resolve & { hearer?: (kept: Kept) => Promise<string> }} c
 * @returns {Promise<{ text: string, by: string } | null>} by: 'dictation', 'send-audio', or the transcription model's id
 */
export async function textVersion(kept, c) {
  if (!kept.audio) return { text: kept.text ?? '', by: 'dictation' };
  const [made] = kept.transcripts;
  if (made) return { text: made[1], by: made[0] };
  for (const id of c.list) {
    if (id === 'send-audio') {
      if (!c.hearer) continue;
      try {
        return { text: await c.hearer(kept), by: 'send-audio' };
      } catch {
        continue; // the next entry may write it down
      }
    }
    if (id === 'dictation' || !c.asr(id)) continue;
    try {
      const text = await c.transcribe(id, kept);
      kept.transcripts.set(id, text);
      return { text, by: id };
    } catch (e) {
      c.onFail?.(id, e);
    }
  }
  return null;
}
```

In `sw.js`, add `'/src/core/voice/resolve.js',` to `SHELL` with the other `src/core/voice/` files.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/voice-resolve.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/voice/resolve.js test/unit/voice-resolve.test.js sw.js && git commit -m "Speech-in list resolution: audio or words for each model attempt, transcripts made once, and text versions when needed (spec §10.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 3: Listening sessions, and the Voice's listening side

**Files:**
- Create: `src/core/voice/listening.js`, `src/core/voice/mic.js`
- Modify: `src/core/voice/voice.js`, `src/core/voice/settings.js`, `src/ui/mic-help.js`, `test/unit/voice-fakes.js`, `test/unit/voice-service.test.js` (the settings defaults grow), `sw.js`
- Test: `test/unit/voice-listening.test.js`

**Interfaces:**
- Consumes: `record` (3a), `HeardMemory`, `listenKind`, `resolveSpeech`, `textVersion` (Task 2), `speechKind`, `modelOf`, `STAND_INS` (3a), `blobBytes` (`src/core/agent/log.js`).
- Produces:
  - `listen({ platform, kind, pauseMs, lang?, now?, onSegment, onSpeech?, onQuiet?, onLevel?, onError, onSwitch? }): Promise<{ readonly kind, stop() }>`.
  - `mic.js`: `micProblem(e, where: 'ios' | 'android' | 'desktop'): { title, body }` (moved from the UI; `src/ui/mic-help.js` keeps `micProblem(e, where = platform())`).
  - `voiceSettings(app)` gives `{ mode: 'auto' | 'on' | 'off', pauseMs, silenceSeconds (2–60, default 8), firstWordsSeconds (5–120, default 15), keepClips (default false), browserVoice, rate }`.
  - `Voice` gains: constructor options `store?`, `where?`; fields `memory: HeardMemory`, `dictationFailed: boolean`, `on: boolean`; methods `settings()`, `refresh(): Promise<boolean>` (On is on; Auto and Off are off until 3c), `howToListen()`, `open({ kind, onSegment, onSpeech?, onQuiet?, onError })` (keeps segments in memory; session type `play-and-record`), `resolver(scope, wake?)` (the `speech` hook for `llm.call`), `writeDown(id, { scope, wake?, hearer? }): Promise<{ text, by } | null>` (`by` is a name), `problem(e)` (`micProblem` for this phone); `WRITE_DOWN` (what the hearing model is asked).
  - `test/unit/voice-fakes.js`: `fakePlatform({ …, dictation?: boolean })` with `dictation.say(text)` and `dictation.fail(code)`; `fakeLlm(o?)`: a fake llm service (chat models, a voice `v1`, transcription models, the speech lists; `calls` records what was asked).

- [ ] **Step 1: Write the failing test**

In `test/unit/voice-fakes.js`, add at the top `import { Bench } from '../../src/core/llm/fallback.js';` and `import { ProviderError } from '../../src/core/llm/contract.js';`; give `fakePlatform` a `dictation = false` option, and replace its `dictation` member with:

```js
    dictation: {
      available: () => dictation,
      /** @param {{ onSegment: (text: string) => void, onSpeech?: () => void, onError: (e: Error) => void }} o */
      open(o) {
        log.push('dictation open');
        heard = o;
        return { close() { log.push('dictation close'); heard = null; } };
      },
      /** Dictation hears someone say this. @param {string} text */
      say(text) { heard?.onSpeech?.(); heard?.onSegment(text); },
      /** Dictation fails, as the browser's recognition does. @param {string} code */
      fail(code) { heard?.onError(Object.assign(new Error(`Phone dictation stopped (${code}).`), { code })); },
    },
```

(with `/** @type {any} */ let heard = null;` next to `frames`), and add:

```js
/**
 * A fake llm service for the Voice: chat models in the main role (with their inputs), a voice (v1),
 * transcription models, and the two speech lists. calls records what was asked.
 * @param {{ main?: { id: string, input: string[] }[], asr?: string[], speechIn?: string[], speechOut?: string[], hears?: string[], failing?: string[], reply?: string }} [o]
 *   hears: what transcription answers, in turn (the last repeats); failing: transcription models that fail; reply: what a chat call answers
 */
export function fakeLlm({ main = [{ id: 'm1', input: ['text'] }], asr = ['t1'], speechIn = ['send-audio', 't1', 'dictation'], speechOut = ['v1', 'browser-voice'], hears = ['what was said'], failing = [], reply = 'the words' } = {}) {
  const bench = new Bench();
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  const cfg = {
    endpoints: { ec: { id: 'ec', type: 'chat' }, eo: { id: 'eo', type: 'say' }, ei: { id: 'ei', type: 'hear' } },
    models: { v1: { id: 'v1', endpoint: 'eo', template: null, user: { providerId: 'tts' }, created: 0 } },
    roles: { main: { models: main.map((m) => m.id), level: 'off' }, 'speech-in': { models: speechIn, level: 'off' }, 'speech-out': { models: speechOut, level: 'off' } },
  };
  for (const m of main) cfg.models[m.id] = { id: m.id, endpoint: 'ec', template: null, user: { providerId: m.id, input: m.input }, created: 0 };
  for (const id of asr) cfg.models[id] = { id, endpoint: 'ei', template: null, user: { providerId: id }, created: 0 };
  let heard = 0;
  return {
    bench,
    calls,
    types: () => new Map([['chat', {}], ['say', { speech: 'out' }], ['hear', { speech: 'in' }]]),
    config: async () => cfg,
    /** @param {{ modelId: string, text: string }} c */
    async synthesize({ modelId, text }) {
      calls.push(`say ${modelId} ${text}`);
      return { clip: { data: enc.encode(`${modelId}:${text}`), mediaType: 'audio/mpeg' } };
    },
    /** @param {{ modelId: string, audio: any, scope?: string, wake?: string }} c */
    async transcribe({ modelId, audio, scope, wake }) {
      calls.push(['hear', modelId, audio.mediaType, scope, wake].filter(Boolean).join(' '));
      if (failing.includes(modelId)) throw new ProviderError('server', `${modelId} is down`);
      return { text: hears[Math.min(heard++, hears.length - 1)] };
    },
    /** @param {any} c */
    async call(c) {
      calls.push(`call ${c.role} ${c.prefer ?? ''} ${c.record?.tag ?? ''} ${c.request.messages[0].parts.map((/** @type {any} */ p) => p.type).join(',')}`);
      return { reply: { text: reply, parts: [{ type: 'text', text: reply }] }, modelId: c.prefer ?? main[0].id };
    },
  };
}
```

In `test/unit/voice-service.test.js`, the settings test's first line becomes:

```js
  assert.deepEqual(voiceSettings({}), { mode: 'auto', pauseMs: 700, silenceSeconds: 8, firstWordsSeconds: 15, keepClips: false, browserVoice: '', rate: 1 });
```

and its second `assert.deepEqual` becomes `assert.deepEqual(voiceSettings({ voice: { pauseMs: 50, browserVoice: 'Samantha', rate: 1.2 } }), { ...voiceSettings({}), browserVoice: 'Samantha', rate: 1.2 });`.

`test/unit/voice-listening.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listen } from '../../src/core/voice/listening.js';
import { Voice, WRITE_DOWN } from '../../src/core/voice/voice.js';
import { voiceSettings } from '../../src/core/voice/settings.js';
import { micProblem } from '../../src/core/voice/mic.js';
import { Registry } from '../../src/core/registry.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { fakePlatform, fakeLlm } from './voice-fakes.js';
import { clip, quiet, cat } from './voice-kit.js';

const lunch = cat(quiet(0.5), await clip('where-lunch'), quiet(1));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('a recording session: the microphone is open until it stops; what it hears comes as audio segments (spec §10.2)', async () => {
  const p = fakePlatform();
  /** @type {any[]} */
  const got = [];
  const s = await listen({ platform: /** @type {any} */ (p), kind: 'record', pauseMs: 700, onSegment: (h) => got.push(h), onError: (e) => assert.fail(e) });
  p.mic.feed(lunch, 16_000);
  s.stop();
  assert.equal(got.length, 1);
  assert.equal(got[0].source, 'mic');
  assert.equal(got[0].audio.mediaType, 'audio/wav');
  assert.equal(s.kind, 'record');
  assert.deepEqual(p.log, ['mic open', 'mic close']);
});

test('a dictation session gives words; when dictation fails, recording takes over from the next segment (spec §10.3)', async () => {
  const p = fakePlatform({ dictation: true });
  /** @type {any[]} */
  const got = [];
  /** @type {string[]} */
  const switched = [];
  const s = await listen({ platform: /** @type {any} */ (p), kind: 'dictation', pauseMs: 700, onSegment: (h) => got.push(h), onError: (e) => assert.fail(e), onSwitch: (e) => switched.push(e.message) });
  p.dictation.say('is there a gas station nearby');
  assert.deepEqual(got.map((h) => [h.source, h.text]), [['dictation', 'is there a gas station nearby']]);
  p.dictation.fail('network');
  await tick();
  assert.equal(s.kind, 'record');
  assert.deepEqual(switched, ['Phone dictation stopped (network).']);
  p.mic.feed(lunch, 16_000);
  assert.equal(got.at(-1).source, 'mic');
  s.stop();
  assert.deepEqual(p.log, ['dictation open', 'dictation close', 'mic open', 'mic close']);
});

/** A Voice over fakes. @param {Parameters<typeof fakeLlm>[0]} [o] @param {{ dictation?: boolean }} [p] */
async function voiceKit(o, { dictation = false } = {}) {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const platform = fakePlatform({ dictation });
  registry.add('voice-browser', 'voice-platform', platform);
  const llm = fakeLlm(o);
  const voice = new Voice({ llm, ws, registry, store, locale: 'en', where: 'ios' });
  return { voice, platform, llm, ws };
}

/** Opens a recording session, says the lunch question, and gives what was heard. @param {Awaited<ReturnType<typeof voiceKit>>} k */
async function hearLunch(k) {
  /** @type {any[]} */
  const got = [];
  const s = await k.voice.open({ kind: 'record', onSegment: (h) => got.push(h), onError: (e) => assert.fail(e) });
  k.platform.mic.feed(lunch, 16_000);
  s.stop();
  return got[0];
}

test('how to listen is judged against the main model expected to hear it (spec §10.3)', async () => {
  assert.equal((await (await voiceKit({ main: [{ id: 'm1', input: ['text', 'audio'] }] })).voice.howToListen()).kind, 'record');
  assert.equal((await (await voiceKit({ main: [{ id: 'm1', input: ['text'] }] })).voice.howToListen()).kind, 'record', 'through t1');
  const k = await voiceKit({ main: [{ id: 'm1', input: ['text'] }], speechIn: ['send-audio', 'dictation'] }, { dictation: true });
  assert.equal((await k.voice.howToListen()).kind, 'dictation');
  k.voice.dictationFailed = true;
  assert.match(/** @type {any} */ (await k.voice.howToListen()).why, /m1 doesn't take audio/);
  const resting = await voiceKit({ main: [{ id: 'm1', input: ['text'] }, { id: 'm2', input: ['text', 'audio'] }], speechIn: ['send-audio'] });
  resting.llm.bench.bench('m1', 60_000);
  assert.equal((await resting.voice.howToListen()).kind, 'record', 'the first main model that is not resting is the one expected to hear');
});

test('open() keeps what it hears in memory, plays and records; the resolver transcribes for a text-only model and benches one that fails', async () => {
  const k = await voiceKit({ asr: ['t1', 't2'], speechIn: ['send-audio', 't1', 't2'], failing: ['t1'], hears: ['where should we stop for lunch'] });
  const h = await hearLunch(k);
  assert.equal(k.voice.memory.get(h.id)?.id, h.id);
  assert.deepEqual(k.platform.sessions, ['play-and-record']);
  const r = await k.voice.resolver('trip-1', 'w-1')({ name: 'm1', input: ['text'] }, { messages: [{ role: 'user', parts: [{ type: 'speech', id: h.id }] }] });
  assert.deepEqual(r.messages[0].parts, [{ type: 'text', text: 'where should we stop for lunch' }]);
  assert.deepEqual(k.llm.calls, ['hear t1 audio/wav trip-1 w-1', 'hear t2 audio/wav trip-1 w-1']);
  assert.ok(k.llm.bench.until('t1') > Date.now());
});

test('writeDown(): the words, and who wrote them down; sent audio is written down by the model that heard it (spec §10.3)', async () => {
  const sent = await voiceKit({ main: [{ id: 'm1', input: ['text', 'audio'] }], speechIn: ['send-audio', 'dictation'], reply: 'tacos please' });
  const h = await hearLunch(sent);
  assert.deepEqual(await sent.voice.writeDown(h.id, { scope: 'trip-1', wake: 'w-1', hearer: 'm1' }), { text: 'tacos please', by: 'm1' });
  assert.deepEqual(sent.llm.calls, ['call main m1 transcribe audio']);
  assert.match(WRITE_DOWN, /exactly what is said/);
  const asr = await voiceKit();
  const h2 = await hearLunch(asr);
  assert.deepEqual(await asr.voice.writeDown(h2.id, { scope: 'trip-1' }), { text: 'what was said', by: 't1' });
  const none = await voiceKit({ speechIn: ['dictation'] });
  const h3 = await hearLunch(none);
  assert.equal(await none.voice.writeDown(h3.id, { scope: 'trip-1' }), null);
  assert.equal(await none.voice.writeDown('s-unknown', { scope: 'trip-1' }), null);
});

test('Settings → Voice: mode, silence, first words and clips, with defaults; refresh() turns voice on for On', async () => {
  assert.deepEqual(voiceSettings({}), { mode: 'auto', pauseMs: 700, silenceSeconds: 8, firstWordsSeconds: 15, keepClips: false, browserVoice: '', rate: 1 });
  assert.deepEqual(voiceSettings({ voice: { mode: 'loud', silenceSeconds: 1, firstWordsSeconds: 500, keepClips: 'yes' } }), voiceSettings({}));
  const k = await voiceKit();
  assert.equal(await k.voice.refresh(), false, 'Auto is off until milestone 3c can tell the situation');
  await updateAppSettings(k.ws, { voice: { mode: 'on', silenceSeconds: 5, keepClips: true } });
  assert.equal(await k.voice.refresh(), true);
  assert.equal(k.voice.on, true);
  assert.equal((await k.voice.settings()).silenceSeconds, 5);
  assert.match(k.voice.problem(Object.assign(new Error('x'), { name: 'NotAllowedError' })).body, /Settings → Apps → Safari → Microphone/);
  assert.equal(micProblem(Object.assign(new Error('x'), { name: 'NotFoundError' }), 'android').title, 'No microphone found');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/voice-listening.test.js`
Expected: FAIL with `Cannot find module '…/src/core/voice/listening.js'`

- [ ] **Step 3: Write the implementation**

`src/core/voice/mic.js`: the body of 3a's `src/ui/mic-help.js` `micProblem`, with `where` a required parameter and no import:

```js
/**
 * What went wrong with the microphone, in plain words, with steps for this phone (spec §17 rule 3).
 * @param {unknown} e @param {'ios' | 'android' | 'desktop'} where @returns {{ title: string, body: string }}
 */
export function micProblem(e, where) {
  const name = /** @type {any} */ (e)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const steps = where === 'ios'
      ? 'On iPhone: open Settings → Apps → Safari → Microphone, choose Ask or Allow, then come back and try again.'
      : where === 'android'
        ? 'On Android: tap the icon left of the address (in the installed app: hold the annai icon, then App info → Permissions), allow the microphone, then try again.'
        : "Allow the microphone for this site in your browser's site settings, then try again.";
    return { title: "annai can't use the microphone", body: `It wasn't allowed. ${steps}` };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { title: 'No microphone found', body: 'This device has no microphone annai can use. Connect one, or type to Shiori instead.' };
  if (name === 'NotReadableError' || name === 'AbortError') return { title: 'The microphone is busy', body: 'Another app is using it, such as a call or a voice recorder. Close it, then try again.' };
  return { title: "The microphone didn't start", body: `${String(/** @type {any} */ (e)?.message ?? e).replace(/\.$/, '')}. Try again; if it keeps happening, restart annai.` };
}
```

`src/ui/mic-help.js` becomes:

```js
import { platform } from './platform.js';
import { micProblem as words } from '../core/voice/mic.js';

/** What went wrong with the microphone, with steps for this phone (spec §17 rule 3). @param {unknown} e @param {'ios' | 'android' | 'desktop'} [where] */
export function micProblem(e, where = platform()) {
  return words(e, where);
}
```

`src/core/voice/listening.js`:

```js
import { record } from './recorder.js';
import { newId } from '../scopes.js';

/**
 * A listening session (spec §10.2): start, stop, and a stream of segments. Recording opens the
 * microphone and the end-of-sentence detector cuts what it hears into segments; phone dictation
 * gives the words itself. They can't run together. When dictation fails, the session records from
 * the next segment on (§10.3). A session never decides to stop listening: its owner does.
 * @typedef {import('./resolve.js').Heard} Heard
 * @param {{ platform: import('./platform.js').VoicePlatform, kind: 'record' | 'dictation', pauseMs: number, lang?: string, now?: () => number,
 *   onSegment: (h: Heard) => void, onSpeech?: () => void, onQuiet?: () => void, onLevel?: (x: number) => void,
 *   onError: (e: Error) => void, onSwitch?: (e: Error) => void }} c
 *   onQuiet: what began like speech wasn't (a click); onSwitch: dictation failed and recording took over
 * @returns {Promise<{ readonly kind: 'record' | 'dictation', stop(): void }>}
 */
export async function listen(c) {
  const now = c.now ?? Date.now;
  /** @type {{ close(): void } | null} */
  let running = null;
  /** @type {'record' | 'dictation'} */
  let kind = c.kind;
  let stopped = false;
  const recording = async () => {
    kind = 'record';
    const r = await record({
      mic: c.platform.mic, pauseMs: c.pauseMs, now, onSpeech: c.onSpeech, onDiscard: c.onQuiet, onLevel: c.onLevel, onError: c.onError,
      onSegment: (s) => c.onSegment({ id: s.id, source: 'mic', audio: s.audio, ms: s.ms, at: s.at }),
    });
    if (stopped) r.close();
    else running = r;
  };
  if (kind === 'dictation') {
    running = c.platform.dictation.open({
      lang: c.lang,
      onSpeech: c.onSpeech,
      onSegment: (text) => c.onSegment({ id: newId('s'), source: 'dictation', text, ms: 0, at: now() }),
      onError: (e) => {
        if (stopped) return;
        running?.close();
        running = null;
        c.onSwitch?.(e);
        recording().catch((err) => c.onError(err));
      },
    });
  } else {
    await recording();
  }
  return {
    get kind() {
      return kind;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      running?.close();
      running = null;
    },
  };
}
```

In `src/core/voice/settings.js`, replace the typedef, `VOICE_DEFAULTS` and `voiceSettings` with:

```js
/**
 * Settings → Voice (spec §10), with their defaults, from the app settings' "voice" entry.
 * @typedef {{ mode: 'auto' | 'on' | 'off', pauseMs: number, silenceSeconds: number, firstWordsSeconds: number, keepClips: boolean, browserVoice: string, rate: number }} VoiceSettings
 *   mode: voice Auto, On or Off (§10.5); pauseMs: the pause that ends a sentence (§10.2); silenceSeconds: how long speak listens for an
 *   answer (§7.1); firstWordsSeconds: how long her first words may take with voice on (§9.6); keepClips: keep what the microphone heard
 *   (§10.2); browserVoice: the system voice's id ('' for the browser's choice); rate: its speed
 */
export const VOICE_DEFAULTS = Object.freeze({ mode: 'auto', pauseMs: 700, silenceSeconds: 8, firstWordsSeconds: 15, keepClips: false, browserVoice: '', rate: 1 });

/** @param {Record<string, any>} app the app settings @returns {VoiceSettings} */
export function voiceSettings(app) {
  const v = app?.voice ?? {};
  const within = (/** @type {unknown} */ x, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ d) => (typeof x === 'number' && x >= lo && x <= hi ? x : d);
  return {
    mode: v.mode === 'on' || v.mode === 'off' ? v.mode : 'auto',
    pauseMs: within(v.pauseMs, 300, 3000, VOICE_DEFAULTS.pauseMs),
    silenceSeconds: within(v.silenceSeconds, 2, 60, VOICE_DEFAULTS.silenceSeconds),
    firstWordsSeconds: within(v.firstWordsSeconds, 5, 120, VOICE_DEFAULTS.firstWordsSeconds),
    keepClips: v.keepClips === true,
    browserVoice: typeof v.browserVoice === 'string' ? v.browserVoice : VOICE_DEFAULTS.browserVoice,
    rate: within(v.rate, 0.5, 2, VOICE_DEFAULTS.rate),
  };
}
```

In `src/core/voice/voice.js`:
- add imports:

```js
import { HeardMemory, listenKind, resolveSpeech, textVersion } from './resolve.js';
import { listen } from './listening.js';
import { micProblem } from './mic.js';
import { blobBytes } from '../agent/log.js';
import { modelOf, STAND_INS } from '../llm/config.js';
import { toBase64 } from '../bytes.js';
```

(`speechKind` is already imported from `../llm/config.js`: merge the two imports);
- add after `restFor`:

```js
/** What the model that heard a segment as audio is asked, to write it down (spec §10.3). */
export const WRITE_DOWN = 'Write down exactly what is said in this audio, in the language it is spoken. Reply with the words only, nothing else. If nothing clear is said, reply with nothing.';
```

- in the class, add fields after `scope`:

```js
  /** Heard segments, until the turn that used them succeeds (spec §10.3). */
  memory = new HeardMemory();
  /** Phone dictation failed in this session: listening records instead (spec §10.3). */
  dictationFailed = false;
  /** Whether voice is on now (spec §10.5); refresh() works it out again. */
  on = false;
```

- the constructor takes `{ llm, ws, registry, store, now = Date.now, locale, where = 'desktop' }` and keeps `this.store = store ?? null;` and `this.where = where;` (its typedef gains `store?: import('../types.js').Store, where?: 'ios' | 'android' | 'desktop'`);
- add the methods:

```js
  /** Settings → Voice. */
  async settings() {
    return voiceSettings(await readAppSettings(this.ws));
  }

  /** Whether voice is on (spec §10.5): On is, Off isn't; Auto works out the situation in milestone 3c, and is off until then. */
  async refresh() {
    this.on = (await this.settings()).mode === 'on';
    return this.on;
  }

  /** How to listen now (spec §10.3), against the first main model that isn't resting: it is expected to hear. */
  async howToListen() {
    const cfg = await this.llm.config();
    const types = this.llm.types();
    const now = this.now();
    const free = (/** @type {string} */ id) => this.llm.bench.until(id) <= now;
    const mainId = (cfg.roles.main?.models ?? []).find((/** @type {string} */ id) => cfg.models[id] && free(id));
    return listenKind({
      list: cfg.roles['speech-in']?.models ?? [],
      model: mainId ? modelOf(cfg.models[mainId]) : null,
      asr: (id) => speechKind(cfg, types, id) === 'in' && free(id),
      dictation: Boolean(this.platform?.dictation.available()) && !this.dictationFailed,
    });
  }

  /**
   * Opens a listening session (spec §10.2): what it hears is kept in memory and handed on; the
   * audio session is play-and-record while it listens (§10.1).
   * @param {{ kind: 'record' | 'dictation', onSegment: (h: import('./resolve.js').Heard) => void, onSpeech?: () => void, onQuiet?: () => void, onError: (e: Error) => void }} o
   */
  async open({ kind, onSegment, onSpeech, onQuiet, onError }) {
    const platform = this.platform;
    if (!platform) throw new Error("This browser can't use the microphone here.");
    const { pauseMs } = await this.settings();
    platform.session('play-and-record');
    return listen({
      platform, kind, pauseMs, lang: this.locale, now: this.now, onSpeech, onQuiet, onError,
      onLevel: (x) => this.#level(x, 'you'),
      onSegment: (h) => {
        this.memory.keep(h);
        onSegment(h);
      },
      onSwitch: () => { this.dictationFailed = true; },
    });
  }

  /**
   * The speech hook for llm.call (spec §10.3): heard speech resolved for each model attempt.
   * Transcriptions are traced in scope, for the wake.
   * @param {string} scope @param {string} [wake]
   * @returns {(model: { name: string, input: string[] }, request: import('../llm/contract.js').Request) => Promise<import('../llm/contract.js').Request>}
   */
  resolver(scope, wake) {
    return async (model, request) => resolveSpeech(request, model, await this.#resolve(scope, wake));
  }

  /** @param {string} scope @param {string} [wake] @returns {Promise<import('./resolve.js').Resolve>} */
  async #resolve(scope, wake) {
    const cfg = await this.llm.config();
    const types = this.llm.types();
    return {
      list: cfg.roles['speech-in']?.models ?? [],
      memory: this.memory,
      asr: (id) => speechKind(cfg, types, id) === 'in' && this.llm.bench.until(id) <= this.now(),
      transcribe: async (id, kept) => String((await this.llm.transcribe({ modelId: id, audio: kept.audio, scope, wake })).text ?? ''),
      clip: (hash) => (this.store ? blobBytes(this.store, hash) : Promise.resolve(null)),
      onFail: (id, e) => this.llm.bench.bench(id, restFor(e), this.now()),
    };
  }

  /**
   * A segment's words, for the log (spec §10.3): a transcript made already, dictation's, or the
   * first entry that can write it down; for "Send audio to the model", the model that heard it
   * (hearer) is asked. null when nothing could, or the segment isn't in memory.
   * @param {string} id @param {{ scope: string, wake?: string, hearer?: string }} o
   * @returns {Promise<{ text: string, by: string } | null>} by: who wrote it down, by name
   */
  async writeDown(id, { scope, wake, hearer }) {
    const kept = this.memory.get(id);
    if (!kept) return null;
    let who = hearer ?? '';
    const r = await textVersion(kept, {
      ...(await this.#resolve(scope, wake)),
      ...(hearer ? {
        hearer: async (/** @type {import('./resolve.js').Kept} */ k) => {
          const audio = /** @type {NonNullable<typeof k.audio>} */ (k.audio);
          const out = await this.llm.call({
            role: 'main', prefer: hearer, level: 'off', scope, record: { tag: 'transcribe', ...(wake ? { wake } : {}) },
            request: { system: WRITE_DOWN, messages: [{ role: 'user', parts: [{ type: 'audio', mediaType: audio.mediaType, data: toBase64(audio.data) }] }], maxOutput: 400 },
          });
          who = out.modelId ?? hearer;
          return String(out.reply.text ?? '').trim();
        },
      } : {}),
    });
    if (!r) return null;
    const by = r.by === 'send-audio' ? who : r.by;
    const cfg = await this.llm.config();
    return { text: r.text, by: STAND_INS[by]?.name ?? (cfg.models[by] ? modelOf(cfg.models[by]).name : by) };
  }

  /** What went wrong with the microphone, with this phone's steps (spec §17 rule 3). @param {unknown} e */
  problem(e) {
    return micProblem(e, this.where);
  }
```

In `sw.js`, add `'/src/core/voice/listening.js',` and `'/src/core/voice/mic.js',` to `SHELL` with the other `src/core/voice/` files.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/voice-listening.test.js test/unit/voice-service.test.js test/unit/ui-pure.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/voice src/ui/mic-help.js test/unit/voice-fakes.js test/unit/voice-listening.test.js test/unit/voice-service.test.js sw.js && git commit -m "Listening sessions: recording or phone dictation, dictation handing over to recording when it fails; the Voice resolves heard speech and writes it down (spec §10.2, §10.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 4: Heard speech in the log, the conversation and the trace

**Files:**
- Modify: `src/core/agent/transcript.js`, `src/core/agent/compaction.js`, `src/core/agent/self-tools.js` (recall), `src/ui/screens/talk.js`, `src/ui/screens/trace.js`
- Test: `test/unit/agent-heard.test.js`

**Interfaces:**
- Consumes: `NOT_TRANSCRIBED` (Task 2); the `speech` part (Task 1).
- Produces:
  - Events: `heard` `{ id, wake, ms, source: 'mic' | 'dictation', text?, answer?: callId, meanwhile?, dismissed?, gate?: 'shiori' | 'chatter' | 'unsure', clip?: hash }` (a kept clip's blob in refs); `heard.text` `{ of: id, wake?, text, by: name | null }`.
  - `Transcript`: a `heard` without `answer` adds `[heard]`, `[heard while you were thinking]` or `[heard, not meant for you]` and a `speech` part (and marks the conversation unanswered, unless dismissed); a `heard` with `answer` waits for its `tool.result`, whose `data.heard` (segment ids) add `speech` parts after the result; `heard.text` gives every part of that segment its words. `transcript.unwritten(): string[]`.
  - `renderForSummary` writes `User (spoke): <words>`; recall writes `#N user said: <words>`.
  - The conversation shows what was heard as the user's bubble (its words when written down; "…" until then); chatter as a line "Heard, not for Shiori: …". The trace's Conversation kind includes `heard` and `heard.text`, with summaries.

- [ ] **Step 1: Write the failing test**

`test/unit/agent-heard.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcript } from '../../src/core/agent/transcript.js';
import { renderForSummary } from '../../src/core/agent/compaction.js';
import { record } from '../../src/core/agent/log.js';
import { traceSummary } from '../../src/ui/screens/trace.js';
import { agentKit } from './agent-kit.js';

/** @param {number} seq @param {string} type @param {any} data */
const ev = (seq, type, data) => ({ seq, type, data });
const none = { texts: {}, images: [] };
/** @param {any[]} parts */
const reply = (parts) => ({ texts: { parts: JSON.stringify(parts) }, images: [] });

test('heard speech in the conversation: a segment, answers inside tool results, and their words once written down (spec §10.3)', () => {
  const t = new Transcript();
  t.apply(ev(1, 'wake', { id: 'w-1', reasons: [{ kind: 'heard', text: '' }] }), none);
  t.apply(ev(2, 'heard', { id: 's-1', wake: 'w-1', ms: 1500, source: 'mic' }), none);
  assert.deepEqual(t.messages, [{ role: 'user', parts: [{ type: 'text', text: '[heard]' }, { type: 'speech', id: 's-1' }] }]);
  assert.equal(t.unanswered, true);
  t.apply(ev(3, 'model.turn', { tag: 'conversation' }), reply([{ type: 'tool_call', id: 'c1', name: 'speak', input: { text: 'Tacos?' } }]));
  t.apply(ev(4, 'heard', { id: 's-2', wake: 'w-1', ms: 900, source: 'mic', answer: 'c1', clip: 'h-clip' }), none);
  t.apply(ev(5, 'tool.result', { id: 'c1', name: 'speak', ok: true, heard: ['s-2'] }), { texts: { content: 'Said aloud. The user said:' }, images: [] });
  assert.deepEqual(t.messages.at(-1), { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'Said aloud. The user said:' }, { type: 'speech', id: 's-2', clip: 'h-clip' }] });
  assert.deepEqual(t.unwritten(), ['s-1', 's-2']);
  t.apply(ev(6, 'heard.text', { of: 's-1', text: 'where should we eat', by: 'GPT Transcribe' }), none);
  t.apply(ev(7, 'heard.text', { of: 's-2', text: 'yes the first one', by: 'GPT Transcribe' }), none);
  assert.deepEqual(t.messages[0].parts[1], { type: 'speech', id: 's-1', text: 'where should we eat' });
  assert.deepEqual(t.messages.at(-1)?.parts[1], { type: 'speech', id: 's-2', clip: 'h-clip', text: 'yes the first one' });
  assert.deepEqual(t.unwritten(), []);
  assert.equal(t.to, 5, 'written-down words change no place in the conversation');
});

test('heard while she was thinking, and heard but not meant for her, carry their labels; chatter wakes nothing', () => {
  const t = new Transcript();
  t.apply(ev(1, 'heard', { id: 's-1', wake: 'w', meanwhile: true, source: 'dictation', text: 'oh and coffee' }), none);
  t.apply(ev(2, 'model.turn', { tag: 'conversation' }), reply([{ type: 'text', text: 'notes' }]));
  t.apply(ev(3, 'heard', { id: 's-2', wake: 'w', dismissed: true, source: 'mic' }), none);
  assert.deepEqual(t.messages[0].parts, [{ type: 'text', text: '[heard while you were thinking]' }, { type: 'speech', id: 's-1', text: 'oh and coffee' }]);
  assert.deepEqual(t.messages[2].parts, [{ type: 'text', text: '[heard, not meant for you]' }, { type: 'speech', id: 's-2' }]);
  assert.equal(t.unanswered, false, 'chatter wakes nothing, even after a restart');
});

test('housekeeping and recall carry what was said aloud, as words', async () => {
  /** @type {any} */
  const messages = [{ role: 'user', parts: [{ type: 'text', text: '[heard]' }, { type: 'speech', id: 's-1', text: 'where should we eat' }, { type: 'speech', id: 's-2' }] }];
  assert.equal(renderForSummary(messages), 'User: [heard]\nUser (spoke): where should we eat\nUser (spoke): [audio, not transcribed]');
  const k = await agentKit([[{ text: '' }]]);
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'heard', text: '' }] } });
  await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-1', wake: 'w-1', ms: 1200, source: 'mic' } });
  await record(k.store, k.trip, { type: 'heard.text', actor: 'system', data: { of: 's-1', text: 'where should we eat', by: 'GPT Transcribe' } });
  const recall = /** @type {any} */ (k.agent.loopTools().find((t) => t.name === 'recall'));
  const out = await recall.run({ query: 'eat' }, {});
  assert.match(out, /#\d+ user said: where should we eat/);
  assert.doesNotMatch(out, /\[annai\] *\n/);
});

test('the trace says what was heard, and what it turned out to say', () => {
  assert.equal(traceSummary({ type: 'heard', data: { id: 's-1', ms: 1500, source: 'mic', answer: 'c1', clip: 'h' } }), '1.5 s from the microphone · an answer · clip kept');
  assert.equal(traceSummary({ type: 'heard', data: { id: 's-2', ms: 0, source: 'dictation', text: 'hi', meanwhile: true, dismissed: true } }), 'phone dictation · "hi" · while she was thinking · not for Shiori');
  assert.equal(traceSummary({ type: 'heard.text', data: { of: 's-1', text: 'where should we eat', by: 'GPT Transcribe' } }), '"where should we eat" · written down by GPT Transcribe');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/agent-heard.test.js`
Expected: FAIL: the transcript has no messages for `heard` (`[]` instead of the `[heard]` message).

- [ ] **Step 3: Write the implementation**

In `src/core/agent/transcript.js`:
- add fields after `#answered`:

```js
  /** Heard answers (spec §10.3), by segment id: their tool's result carries them. @type {Map<string, Part>} */
  #heard = new Map();
```

- in `apply`, the `wake` branch's filter becomes `(w) => w.kind !== 'user' && w.kind !== 'heard' && w.text`;
- add branches before the `tool.result` branch:

```js
    } else if (e.type === 'heard') {
      // What the microphone heard (spec §10.3); its words come with it (dictation) or later (heard.text).
      /** @type {Part} */
      const speech = { type: 'speech', id: d.id, ...(typeof d.text === 'string' ? { text: d.text } : {}), ...(d.clip ? { clip: d.clip } : {}) };
      if (d.answer) {
        this.#heard.set(d.id, speech); // an answer: part of its tool's result
        return;
      }
      const label = d.dismissed ? '[heard, not meant for you]' : d.meanwhile ? '[heard while you were thinking]' : '[heard]';
      this.#add('user', [{ type: 'text', text: label }, speech]);
      if (!d.dismissed) {
        this.unanswered = true;
        this.waiting = 'user';
      }
    } else if (e.type === 'heard.text') {
      // A segment's words, written down later: every place it is sent now sends them (spec §10.3).
      const text = String(d.text ?? '');
      const had = this.#heard.get(d.of);
      if (had) this.#heard.set(d.of, { ...had, text });
      this.messages = this.messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => (p.type === 'speech' && p.id === d.of ? { ...p, text } : p)) }));
      return;
```

- the `tool.result` branch's `#add` becomes:

```js
      const heard = (Array.isArray(d.heard) ? d.heard : []).map((/** @type {string} */ id) => this.#heard.get(id) ?? /** @type {Part} */ ({ type: 'speech', id }));
      this.#add('user', [{ type: 'tool_result', id: d.id, content: texts.content ?? '', ...(d.ok === false ? { isError: true } : {}) }, ...r.images, ...heard]);
```

- add the method:

```js
  /** The heard segments here whose words aren't written down yet (spec §10.3). @returns {string[]} */
  unwritten() {
    /** @type {string[]} */
    const out = [];
    for (const m of this.messages) for (const p of m.parts) if (p.type === 'speech' && p.text === undefined && !out.includes(p.id)) out.push(p.id);
    return out;
  }
```

In `src/core/agent/compaction.js`, import `NOT_TRANSCRIBED` from `'../voice/resolve.js'` and add to `asText`'s map, before `return '';`:

```js
    if (p.type === 'speech') return `User (spoke): ${p.text ?? NOT_TRANSCRIBED}`;
    if (p.type === 'audio') return 'User: [audio]';
```

In `src/core/agent/self-tools.js` (`recall`):
- `shown` gains `'heard'`;
- before `const lines`, add `const words = new Map(all.filter((e) => e.type === 'heard.text').map((e) => [e.data?.of, String(e.data?.text ?? '')]));`
- in `lines`, add a branch after the `msg.user` one:

```js
      else if (e.type === 'heard') out.push(`#${e.seq} ${t.dismissed ? 'someone said, not to Shiori' : 'user said'}: ${t.text ?? words.get(t.id) ?? '[audio]'}`);
```

- the `wake` branch's filter becomes `(w) => w.kind !== 'user' && w.kind !== 'heard'`.

In `src/ui/screens/talk.js`:
- `SHOWN` gains `'heard', 'heard.text'`;
- in `renderTalk`, next to `asks`, add `/** @type {Map<string, HTMLElement>} heard speech whose words are still being written down */ const unheard = new Map();`
- in `item`, before the `out.show` branch:

```js
    if (e.type === 'heard') {
      // What annai heard you say, so you can see what it understood (spec §10.3).
      const words = h('span', { text: typeof d.text === 'string' ? d.text : '…' });
      if (typeof d.text !== 'string') unheard.set(d.id, words);
      return d.dismissed ? h('li', { class: 'system-line' }, 'Heard, not for Shiori: ', words) : h('li', { class: 'you heard' }, h('p', {}, words));
    }
    if (e.type === 'heard.text') {
      const words = unheard.get(d.of);
      if (words) words.textContent = String(d.text ?? '');
      unheard.delete(d.of);
      return null;
    }
```

In `src/ui/screens/trace.js`:
- `KINDS.Conversation` gains `'heard', 'heard.text'`;
- in `traceSummary`, before the `out.show` line:

```js
  if (e.type === 'heard') {
    return [d.source === 'dictation' ? 'phone dictation' : `${((d.ms ?? 0) / 1000).toFixed(1)} s from the microphone`, d.text ? `"${cut(d.text)}"` : null,
      d.answer ? 'an answer' : d.meanwhile ? 'while she was thinking' : null, d.dismissed ? 'not for Shiori' : null, d.clip ? 'clip kept' : null].filter(Boolean).join(' · ');
  }
  if (e.type === 'heard.text') return `"${cut(d.text)}"${d.by ? ` · written down by ${d.by}` : ''}`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/agent-heard.test.js test/unit/agent-transcript.test.js test/unit/agent-compaction.test.js test/unit/agent-self.test.js test/unit/ui-pure.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/agent src/ui/screens/talk.js src/ui/screens/trace.js test/unit/agent-heard.test.js sw.js && git commit -m "Heard speech in the log: segments and their words in the conversation, housekeeping, recall and the trace (spec §10.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 5: Speaking and listening in the loop

**Files:**
- Create: `src/core/agent/listen.js`
- Modify: `src/core/agent/loop.js`, `src/core/agent/tools.js` (`ToolOutput`, `normalize`), `src/core/agent/instructions.js` (`CORE`), `src/core/agent/context.js` (the now block's words for voice on), `test/unit/agent-kit.js`, `test/unit/voice-fakes.js` (`micFails`), `sw.js`
- Test: `test/unit/agent-voice.test.js`

**Interfaces:**
- Consumes: `Voice` with `on`, `refresh()`, `settings()`, `howToListen()`, `open()`, `resolver()`, `speaker`, `memory`, `problem()` (3a, Task 3); `parsePartialJSON`; the `restart` event, `llm.call`'s `speech` and `firstOutputMs` (Task 1); `heard` events and `Transcript` handling (Task 4).
- Produces:
  - `new Agent({ …, voice? })`; `agent.voice`.
  - `agent.tap(): 'cut' | 'stopped' | 'listening' | 'typing'` (spec §6.7, §10.4).
  - States `listening` ("Listening") and `hearing` ("Hearing you").
  - With voice on: `speak` plays what streamed in, then listens; its result is `Said aloud.` / `The user stopped you after: "…".` / `The user stopped you before you said anything.`, followed by `The user said:` (and `heard: [segment id]`), `The user wrote: …`, `Heard nothing (N seconds).`, or `annai couldn't listen: … The user may type.`; with `sleep` in the same reply, just the first sentence. `wait` listens (`The user said:` / `Nothing yet (N seconds).`). `ask` speaks its question and takes a tap, typing or a spoken answer.
  - `ToolOutput` gains `heard?: string[]` and `endTurn?: boolean`; `tool.result` events carry `heard`.
  - `listen.js`: `Got` (what a listen got), `spokenText(spoken)`, `unspoken(why)`.
  - `agentKit(scripts, { voice: { mode?, speechIn?, hears?, failing?, decide?, dictation?, keepClips?, playMs?, micFails?, models? } })` gives `voice`, `platform`, `said` and `transcribed`; `until(fn, ms?)`; `hear(k, clipName)`.

- [ ] **Step 1: Write the failing test**

In `test/unit/voice-fakes.js`, give `fakePlatform` a `micFails = ''` option (its type gains `micFails?: string`), and as the first line of `mic.open`:

```js
        if (micFails) throw Object.assign(new Error('Permission denied'), { name: micFails });
```

In `test/unit/agent-kit.js`:
- add imports:

```js
import { Voice } from '../../src/core/voice/voice.js';
import { decide } from '../../src/core/llm/decide.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { fakePlatform } from './voice-fakes.js';
import { clip, quiet, cat } from './voice-kit.js';
```

- the options type gains `voice?: { mode?: 'on' | 'off', speechIn?: string[], hears?: string[], failing?: string[], decide?: any[], dictation?: boolean, keepClips?: boolean, playMs?: number, micFails?: string }`, documented as: "voice: Shiori with a voice (spec §10): a fake device; a voice (m-say) and a transcription model (m-hear) that hears hears, in turn (the last repeats); decide: a script for a quick-decision model (the gate); micFails: the microphone refuses with this error name";
- the options' destructuring gains `voice: v`; after the `if (utility) { … }` block, add:

```js
  if (v) {
    config.endpoints['ep-say'] = { id: 'ep-say', type: 'say', template: null, user: { name: 'Say' }, created: 0 };
    config.models['m-say'] = { id: 'm-say', endpoint: 'ep-say', template: null, user: { providerId: 'voice' }, created: 0 };
    config.endpoints['ep-hear'] = { id: 'ep-hear', type: 'hear', template: null, user: { name: 'Hear' }, created: 0 };
    config.models['m-hear'] = { id: 'm-hear', endpoint: 'ep-hear', template: null, user: { providerId: 'ears' }, created: 0 };
    config.roles['speech-out'] = { models: ['m-say'], level: 'off' };
    config.roles['speech-in'] = { models: v.speechIn ?? ['send-audio', 'm-hear', 'dictation'], level: 'off' };
    if (v.decide) {
      config.endpoints['ep-d'] = { id: 'ep-d', type: 'scripted', template: null, user: { name: 'ED', tunables: { script: v.decide } }, created: 0 };
      config.models['m-d'] = { id: 'm-d', endpoint: 'ep-d', template: null, user: { providerId: 'model-d', prices: { input: 1, output: 1 }, input: ['text'] }, created: 0 };
      config.roles.decide.models = ['m-d'];
    }
  }
```

- before `const bench = new Bench();`, add:

```js
  /** The endpoint types: the scripted model, and fake speech types whose calls the llm below answers. */
  const types = new Map([['scripted', watched], ['say', { type: 'say', name: 'Say', speech: 'out', pluginId: 'test' }], ['hear', { type: 'hear', name: 'Hear', speech: 'in', pluginId: 'test' }]]);
  /** @type {string[]} what the voice was asked to say */
  const said = [];
  /** @type {string[]} the transcription models asked, in turn */
  const transcribed = [];
  const hears = [...(v?.hears ?? ['what was said'])];
```

- in `llm`, `call`'s `types: new Map([['scripted', watched]])` becomes `types`, and it also passes `speech: c.speech, firstOutputMs: c.firstOutputMs`; add to `llm`:

```js
    types: () => types,
    /** @param {{ modelId: string, text: string }} c */
    synthesize: async (c) => {
      said.push(c.text);
      return { clip: { data: utf8(`${c.modelId}:${c.text}`), mediaType: 'audio/mpeg' }, cost: 0, ms: 1 };
    },
    /** @param {{ modelId: string }} c */
    transcribe: async (c) => {
      transcribed.push(c.modelId);
      if (v?.failing?.includes(c.modelId)) throw new ProviderError('server', `${c.modelId} is down`);
      return { text: hears.length > 1 ? hears.shift() : hears[0], cost: 0, ms: 1 };
    },
    /** @param {any} c */
    gate: async (c) => decide({ prompt: c.prompt, options: c.options, parts: c.parts, fallback: false, call: (role, request) => llm.call({ role, request, speech: c.speech, scope: c.scope, record: { tag: 'gate' } }) }),
```

- before `const agent = new Agent(…)`, add:

```js
  /** @type {Voice | null} */
  let voice = null;
  /** @type {ReturnType<typeof fakePlatform> | null} */
  let platform = null;
  if (v) {
    platform = fakePlatform({ playMs: v.playMs ?? 5, dictation: v.dictation, micFails: v.micFails });
    registry.add('voice-browser', 'voice-platform', platform);
    await updateAppSettings(ws, { voice: { mode: v.mode ?? 'on', keepClips: Boolean(v.keepClips) } });
    voice = new Voice({ llm, ws, registry, store, locale: 'en', where: 'ios' });
  }
```

  and pass `voice` to the `Agent`; return `voice: /** @type {any} */ (voice), platform: /** @type {any} */ (platform), said, transcribed` with the rest;
- add at the end:

```js
/** Waits until fn() is true (every 2 ms, at most ms). @param {() => boolean} fn @param {number} [ms] */
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`still waiting after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** The microphone hears one of the speech clips, then a pause: one segment. @param {any} k @param {string} name */
export async function hear(k, name) {
  k.platform.mic.feed(cat(quiet(0.3), await clip(name), quiet(1)), 16_000);
}
```

`test/unit/agent-voice.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';
import { clip, quiet, cat } from './voice-kit.js';

/** speak, as a model whose arguments stream would send it. @param {string} text @param {any} [more] */
const speakStep = (text, more = {}) => ({ stream: true, toolCalls: [{ name: 'speak', input: { text } }], ...more });
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
/** What played, in order. @param {any} k */
const plays = (k) => k.platform.log.filter((/** @type {string} */ l) => l.startsWith('play ')).map((/** @type {string} */ l) => l.replace(/^play m-say:/, ''));
/** Each call of a tool's result, in order. @param {any} k @param {string} name */
const results = async (k, name) => (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === name);

test('speak plays as the reply streams in, sentence by sentence, then listens; the spoken answer comes back as heard speech (spec §7.1, §10.1)', async () => {
  const k = await agentKit([[speakStep('There is a taco stand ahead. Want to stop?', { pieceMs: 15 }), say('Great.')]], { voice: { speechIn: ['m-hear'], hears: ['yes the first one'] } });
  let playedBeforeTheCall = -1;
  k.agent.on('event', (e) => { if (e.type === 'tool.call' && e.data.name === 'speak' && playedBeforeTheCall < 0) playedBeforeTheCall = plays(k).length; });
  k.agent.send('Where should we eat?');
  await until(() => k.agent.state.name === 'listening');
  assert.ok(playedBeforeTheCall >= 1, 'the first sentence played before the reply was complete');
  await hear(k, 'first-one');
  await k.agent.idle();
  assert.deepEqual(plays(k), ['There is a taco stand ahead.', 'Want to stop?', 'Great.']);
  const [speak] = await results(k, 'speak');
  assert.equal(speak.data.content, 'Said aloud. The user said:');
  const [heard] = await k.events(['heard']);
  assert.deepEqual(speak.data.heard, [heard.data.id]);
  assert.equal(heard.data.answer, speak.data.id);
  const last = k.requests[1].messages.at(-1);
  assert.deepEqual(last.parts.slice(0, 2), [{ type: 'tool_result', id: last.parts[0].id, content: 'Said aloud. The user said:' }, { type: 'text', text: 'yes the first one' }]);
  assert.deepEqual(k.transcribed, ['m-hear']);
  assert.equal(k.agent.state.name, 'sleeping');
  assert.equal(k.platform.log.at(-1), 'mic close');
  assert.deepEqual(k.platform.sessions, ['transient', 'play-and-record', 'transient', 'playback']);
});

test('sleep in the same reply: she speaks and does not listen; the microphone never opens (spec §7.1)', async () => {
  const k = await agentKit([[say('Noted.')]], { voice: {} });
  k.agent.send('Dinner is at 6:30');
  await k.agent.idle();
  assert.deepEqual(plays(k), ['Noted.']);
  assert.equal(k.platform.opens, 0);
  assert.equal((await results(k, 'speak'))[0].data.content, 'Said aloud.');
  assert.equal((await k.events(['out.speak']))[0].data.voice, true);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('heard nothing: speak stops listening after the silence limit (spec §7.1)', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: {} });
  k.agent.send('Thanks');
  await k.agent.idle();
  assert.equal((await results(k, 'speak'))[0].data.content, 'Said aloud. Heard nothing (8 seconds).');
  assert.deepEqual(k.platform.log.filter((/** @type {string} */ l) => l.startsWith('mic')), ['mic open', 'mic close']);
});

test('voice off: speak shows a bubble and listens to nothing; the now block says which; voice on asks for first words sooner (spec §6.3, §9.6)', async () => {
  const off = await agentKit([[say('Here.')]], { voice: { mode: 'off' } });
  off.agent.send('Hi');
  await off.agent.idle();
  assert.deepEqual(plays(off), []);
  assert.equal((await results(off, 'speak'))[0].data.content, 'shown');
  assert.match(off.requests[0].tail, /voice: off/);
  const on = await agentKit([[say('Here.')]], { voice: {} });
  /** @type {any[]} */
  const calls = [];
  const call = on.llm.call;
  on.llm.call = (/** @type {any} */ c) => { calls.push(c); return call(c); };
  on.agent.send('Hi');
  await on.agent.idle();
  assert.match(on.requests[0].tail, /voice: on/);
  assert.equal(calls[0].firstOutputMs, 15_000);
  assert.equal(typeof calls[0].speech, 'function');
});

test('tapping her while she speaks stops her, keeps where, and opens the microphone; what is said next answers (spec §10.4)', async () => {
  const k = await agentKit([[speakStep('Bixby Bridge is two miles ahead. It opened in 1932.'), say('OK, the beach.')]], { voice: { playMs: 60, speechIn: ['m-hear'], hears: ['tell me about the beach'] } });
  k.agent.send('What is ahead?');
  await until(() => plays(k).length === 1);
  assert.equal(k.agent.tap(), 'cut');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  assert.equal((await results(k, 'speak'))[0].data.content, 'The user stopped you after: "Bixby Bridge is…". The user said:');
  assert.ok(!plays(k).includes('It opened in 1932.'));
  assert.equal(k.platform.log.filter((/** @type {string} */ l) => l === 'mic open').length, 1, 'one listening window, from the tap');
  assert.equal(k.requests.length, 2);
});

test('tapping her while she sleeps starts listening; the first thing said wakes her; the microphone closes after her turn (spec §10.4)', async () => {
  const k = await agentKit([[say('Yes, there is a café ahead.')]], { voice: { speechIn: ['m-hear'], hears: ['is there coffee nearby'] } });
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.deepEqual(k.requests[0].messages.at(-1).parts.slice(0, 2), [{ type: 'text', text: '[heard]' }, { type: 'text', text: 'is there coffee nearby' }]);
  assert.match(k.requests[0].tail, /woke for: the user spoke/);
  assert.deepEqual(plays(k), ['Yes, there is a café ahead.']);
  assert.equal(k.platform.log.at(-1), 'mic close');
  assert.equal(k.agent.state.name, 'sleeping');
});

test('a tap nobody speaks into closes after the silence limit; a tap while she listens stops listening; voice off opens typing', async () => {
  const k = await agentKit([[say('x')]], { voice: {} });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await until(() => k.agent.state.name === 'sleeping', 1000);
  assert.deepEqual(k.platform.log, ['mic open', 'mic close']);
  assert.equal(k.requests.length, 0);
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  assert.equal(k.agent.tap(), 'stopped');
  assert.equal(k.agent.state.name, 'sleeping');
  assert.equal(k.platform.log.at(-1), 'mic close');
  const off = await agentKit([[say('x')]], { voice: { mode: 'off' } });
  assert.equal(off.agent.tap(), 'typing');
});

test('while she thinks, the microphone keeps recording; what is heard reaches her next call as heard while you were thinking (spec §6.1, §10.4)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'Want tacos?' } }] },
    { delayMs: 120, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] },
    say('Tacos and a coffee, noted.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['yes please', 'and a coffee'] } });
  k.agent.send('Lunch ideas?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.deepEqual(k.requests[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard while you were thinking]' }, { type: 'text', text: 'and a coffee' }]);
  assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => [Boolean(e.data.answer), Boolean(e.data.meanwhile)]), [[true, false], [false, true]]);
});

test('nothing heard is lost: speech that comes as she goes to sleep starts a new turn (spec §10.4)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'Anything else?' } }] },
    { delayMs: 120, toolCalls: [{ name: 'sleep', input: {} }] },
    say('Got it, a gas station.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['no thanks', 'actually find gas'] } });
  k.agent.send('Thanks');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.equal(k.requests.length, 3);
  assert.equal((await k.events(['wake'])).length, 2);
  assert.match(JSON.stringify(k.requests[2].messages.at(-1)), /actually find gas/);
  assert.equal(plays(k).at(-1), 'Got it, a gas station.');
});

test('speech still going on when the microphone closes for her to speak is kept, and reaches her (spec §10.4)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'speak', input: { text: 'One moment.' } }] },
    { delayMs: 60, stream: true, toolCalls: [{ name: 'speak', input: { text: 'Here is what I found.' } }] },
    say('And the rest, noted.'),
  ]], { voice: { speechIn: ['m-hear'], hears: ['ok', 'and also'] } });
  k.agent.send('Find a park');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2);
  k.platform.mic.feed(cat(quiet(0.3), (await clip('gas-station')).subarray(0, 12_000)), 16_000); // mid-sentence when she starts to speak
  await k.agent.idle();
  assert.deepEqual(k.requests[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard while you were thinking]' }, { type: 'text', text: 'and also' }]);
});

test('a reply that breaks off mid-speak stops what it had begun; the next model says its own, whole (spec §9.6)', async () => {
  const k = await agentKit([[speakStep('First sentence here. Second one never comes.', { breakAt: 4 })], [say('From the other model.')]], { voice: {} });
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(plays(k).at(-1), 'From the other model.');
  assert.ok(!plays(k).includes('Second one never comes.'));
  assert.equal((await k.events(['out.speak'])).length, 1);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('ask is spoken too, and a spoken answer answers it; wait listens (spec §7.1)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } }] },
    { toolCalls: [{ name: 'wait', input: { seconds: 10 } }] },
    { toolCalls: [{ name: 'wait', input: { seconds: 10 } }] },
    { toolCalls: [{ name: 'sleep', input: {} }] },
  ]], { voice: { speechIn: ['m-hear'], hears: ['keep it', 'one more thing'] } });
  k.agent.send('We are late');
  await until(() => k.agent.state.name === 'listening');
  assert.deepEqual(plays(k), ['Keep the 6:30 dinner?']);
  await hear(k, 'first-one');
  await until(() => k.requests.length === 2 && k.agent.state.name === 'listening');
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.equal((await results(k, 'ask'))[0].data.content, 'The user said:');
  assert.deepEqual((await results(k, 'wait')).map((/** @type {any} */ e) => e.data.content), ['The user said:', 'Nothing yet (10 seconds).']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/agent-voice.test.js`
Expected: FAIL: nothing plays (`plays(k)` is `[]`), and `k.agent.tap` is not a function.

- [ ] **Step 3: Write the words the tools return**

`src/core/agent/listen.js`:

```js
/**
 * The words speak, wait and ask return about listening (spec §7.1). What the user said follows them
 * as heard speech, resolved for each model, so these say only what happened.
 * @typedef {{ heard?: import('../voice/resolve.js').Heard, dismissed?: import('../voice/resolve.js').Heard, text?: string, chosen?: string,
 *   stopped?: boolean, deaf?: string, gate?: string }} Got
 *   what a listen got: speech for her (heard) or not (dismissed), typing, a tap on an option, a stop, why annai couldn't listen,
 *   or nothing (a silence); gate: what the quick-decision gate made of it
 */

/** How speak's result begins: what she said, and whether the user stopped her (spec §7.1). @param {import('../voice/speaker.js').Spoken} spoken */
export function spokenText(spoken) {
  if (!spoken.cut) return 'Said aloud.';
  return spoken.heard ? `The user stopped you after: "${spoken.heard}".` : 'The user stopped you before you said anything.';
}

/** A reply that couldn't be said aloud, for speak's result. @param {'no-voice' | 'blocked'} why */
export function unspoken(why) {
  return `Not said aloud: ${why === 'blocked' ? "the browser didn't let annai play sound yet" : 'no voice in the speech-out list could speak'}. It was shown on screen instead; the user may type.`;
}
```

- [ ] **Step 4: Teach the tools' output and Shiori's instructions**

In `src/core/agent/tools.js`:
- `ToolOutput` becomes `{ content: string, images?: Media[], document?: Media, isError?: boolean, heard?: string[], endTurn?: boolean }`, documented: "heard: segments the user said in answer, which follow the result (spec §10.3); endTurn: the turn ends after this step (chatter heard, §10.4)";
- `ToolCall` gains `voice?: boolean, sleeping?: boolean` ("voice: voice is on for this turn (spec §10.5); sleeping: sleep came in the same reply");
- in `normalize`, the condition gains `out.heard || out.endTurn ||` before `out.isError !== undefined`.

In `src/core/agent/instructions.js`, replace the first bullet of "How you talk" with:

```
- You reach the user only through tools. speak says a short message: with voice on it plays aloud and then listens, and its result is what the user said, where they stopped you, or that nothing was heard; with voice off it shows as a bubble. show puts up a card: text, a place, links, a booking, a photo, or a choice. ask asks a question with buttons and waits for the answer (with voice on it is spoken, and may be answered aloud). Anything else you write is your private notes: the user never sees it, though it is kept in the trace.
```

and the third bullet with:

```
- Lines starting with [annai] come from the app, not the user. "[meanwhile, the user wrote]" is the user writing while you were working. "[heard]" is what the microphone heard the user say; "[heard while you were thinking]" came while you were working; "[heard, not meant for you]" was judged to be people talking among themselves: know it, but don't answer it.
```

In `src/core/agent/context.js`, `VOICE.on` becomes `'on (speak plays aloud, then listens; wait listens; ask is spoken too)'`.

- [ ] **Step 5: Speak, listen and tap in the loop**

In `src/core/agent/loop.js`:

1. Imports: add `import { parsePartialJSON } from '../llm/partial-json.js';` and `import { spokenText, unspoken } from './listen.js';`.
2. Typedefs: `WakeKind` gains `'heard'`; `Wake` gains `heard?: import('../voice/resolve.js').Heard, gate?: string` ("heard: what the microphone heard (spec §6.1); gate: what the quick-decision gate made of it"); `StateName` gains `'listening' | 'hearing'`; add

```js
 * @typedef {import('../voice/resolve.js').Heard} Heard
 * @typedef {import('./listen.js').Got} Got
 * @typedef {{ id: string, kind: 'ask' | 'wait', resolve: (v: Got) => void, listening?: boolean, hold?: () => void, arm?: () => void }} Pending
 *   waiting for the user; listening: an answer may be spoken; hold and arm stop and start the silence limit
```

3. `LABELS` gains `listening: 'Listening', hearing: 'Hearing you'`.
4. `#pending`'s type becomes `{Pending | null}`.
5. Fields, after `#on`:

```js
  /** Speaking and hearing (spec §10); null: no voice here. @type {import('../voice/voice.js').Voice | null} */
  voice = null;
  /** Speech streaming in, by speak call (spec §10.1). @type {Map<string, import('../voice/speaker.js').Utterance>} */
  #utterances = new Map();
  /**
   * The listening window (spec §10.4), and who opened it: a tap (until the first thing said, or a
   * silence) or the turn (until it ends). @type {{ owner: 'tap' | 'turn', session: { stop(): void } | null } | null}
   */
  #ear = null;
  /** Openings of the window, one at a time. @type {Promise<unknown>} */
  #earLock = Promise.resolve();
  /** Heard segments are handled one at a time, in order. @type {Promise<void>} */
  #hearing = Promise.resolve();
  /** Closes a tap's window nobody spoke into. @type {any} */
  #quiet = null;
  /** Voice for the turn running now (spec §10.5). */
  #voiceNow = false;
  /** The user stopped her during this step: nothing more is said until she has listened. */
  #cut = false;
  /** The model that answered last in this turn: it heard any audio sent (spec §10.3). @type {string | null} */
  #heardBy = null;
```

6. The constructor's parameter gains `voice` (type `voice?: import('../voice/voice.js').Voice | null`); keep it: `this.voice = voice ?? null;`.
7. `open(trip)`: as its first lines,

```js
    this.#closeEar();
    this.voice?.speaker.stop();
```

8. `interrupt()`: after `this.#abort?.abort();`, add `this.voice?.speaker.stop();`.
9. `idle()` becomes:

```js
  /** Settles when no turn is running, nothing is queued, and what was heard has been handled. */
  async idle() {
    await this.#hearing;
    if (!this.#busy && !this.#queue.length && !this.#checking) return;
    await new Promise((resolve) => { this.#idle.push(() => resolve(undefined)); });
  }
```

10. `#take()`: the user's wakes are `w.kind === 'user' || w.kind === 'choice' || w.kind === 'heard'` (both filters).
11. `#drain()`'s `finally`: replace `this.#setState(this.online() ? 'sleeping' : 'offline');` with

```js
      // A tap's listening window outlives the turn until something is said, or a silence (spec §10.4).
      const tapped = this.#ear?.owner === 'tap';
      this.#setState(tapped ? 'listening' : this.online() ? 'sleeping' : 'offline');
      if (tapped) this.#armQuiet();
```

12. `#warmSummary`'s `this.llm.call({ … })` gains `...(this.voice ? { speech: this.voice.resolver(this.scope) } : {})`.
13. `#reason(w)`: add `if (w.kind === 'heard') return 'the user spoke';`.
14. `#logWakes`: the meanwhile `others` filter adds `&& w.kind !== 'heard'`, and the loop over wakes begins with

```js
      if (w.kind === 'heard' && w.heard) {
        await this.#logHeard(w.heard, { wake: wakeId, meanwhile, gate: w.gate }, log);
        continue;
      }
```

15. `#turn(wakes)`: wrap the body (from `await this.#logWakes(wakes, wakeId, false);` to the end of the `for (;;)` loop) in `try { … } finally { await this.#afterTurn().catch((e) => console.warn('the end of a turn failed', e)); }`, and add before the `try`:

```js
    this.#voiceNow = await this.#voiceOn();
    this.#heardBy = null;
```

    In the loop: the `nowBlock` call's `voice: 'off'` becomes `voice: this.#voiceNow ? 'on' : 'off'`; just before `this.#setState('thinking');` add `this.#cut = false;`; the `this.llm.call({ … })` gains

```js
          onEvent: (/** @type {any} */ ev) => this.#streamed(ev),
          ...(this.voice ? { speech: this.voice.resolver(this.scope, wakeId) } : {}),
          ...(this.#voiceNow ? { firstOutputMs: await this.#firstWordsMs() } : {}),
```

    after `steps++;` add `this.#heardBy = result.modelId;`; the call loop becomes

```js
      let endTurn = false;
      for (const c of ordered) {
        const output = await this.#runCall(c, tools, { wakeId, signal: abort.signal, model, sleeping, providerOff: via.off });
        if (output.endTurn) endTurn = true;
        if (stuck.see(c.name, c.input, output.content)) stop = true;
      }
```

    and `if (sleeping || abort.signal.aborted) break;` becomes `if (sleeping || endTurn || abort.signal.aborted) break;`.
    `#waitFor`'s return type becomes `Promise<Got>` (a spoken answer can reach an ask that waits for a tap).
16. `#runCall`: the `call` object gains `voice: this.#voiceNow`; the `tool.result` event's data gains `...(output.heard?.length ? { heard: output.heard } : {})`.
17. The talk tools: `speak` becomes

```js
      {
        name: 'speak', pluginId: core, group: 'Talk',
        description: 'Say something to the user: a short message, as you would say it aloud. With voice on it plays aloud, then listens: the result is what the user said, where they stopped you, or that nothing was heard. With voice off it shows as a bubble.',
        input: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] },
        run: async (/** @type {{ text: string }} */ i, /** @type {any} */ call) => {
          const text = String(i.text ?? '');
          await this.#log({ type: 'out.speak', actor: 'shiori', data: { id: call.id, wake: call.wake, ...(call.voice ? { voice: true } : {}) }, texts: [['text', text]] });
          if (call.voice && this.voice) return this.#say(text, call);
          this.#setState('speaking');
          return call.sleeping ? 'shown' : SPEAK_RESULT;
        },
      },
```

    `ask`'s `run`, after its `out.ask` log line, gets a voice branch before `const got = await this.#waitFor(call.id, 'ask', 0);`:

```js
          if (call.voice && this.voice) return this.#askAloud(i.question, call);
```

    `wait`'s `run` begins (after `const seconds = …`) with:

```js
          if (call.voice && this.voice) {
            const got = await this.#listenFor(call.id, 'wait', seconds);
            if (!got.deaf) return this.#answer('', got, call, `Nothing yet (${seconds} seconds).`);
          }
```

    and the `wait` description becomes `'Keep listening for the user’s answer for a while (with voice off, wait for typing).'`.
18. Add the methods (after `#waitFor`):

```js
  /** Whether voice is on for this turn (spec §10.5): it is on, and speak isn't switched off (§7.2). */
  async #voiceOn() {
    if (!this.voice) return false;
    await this.voice.refresh();
    return this.voice.on && (await toolSwitches(this.ws)).speak !== false;
  }

  /** How long her first words may take with voice on (spec §9.6: tighter for voice); the main role's own limit when lower. */
  async #firstWordsMs() {
    const { firstWordsSeconds } = await /** @type {import('../voice/voice.js').Voice} */ (this.voice).settings();
    const own = (await this.llm.config()).roles?.main?.firstOutputSeconds;
    return Math.min(firstWordsSeconds, own ?? Infinity) * 1000;
  }

  /**
   * Speech streams in while the model writes it, and plays sentence by sentence (spec §10.1). A
   * call that starts over (another model) drops what it had begun to say.
   * @param {any} ev a stream event
   */
  #streamed(ev) {
    if (ev.type === 'restart') {
      for (const u of this.#utterances.values()) u.stop();
      this.#utterances.clear();
      return;
    }
    if (!this.#voiceNow || !this.voice || (ev.type !== 'tool_input' && ev.type !== 'tool_call') || ev.name !== 'speak') return;
    let u = this.#utterances.get(ev.id);
    if (!u) {
      u = this.voice.speaker.begin();
      this.#utterances.set(ev.id, u);
      if (this.#cut) u.stop(); // she was stopped: nothing more until she has listened
      else {
        this.#closeEar('speaking'); // half-duplex (spec §10.4)
        this.#setState('speaking');
      }
    }
    if (ev.type === 'tool_input') {
      const text = parsePartialJSON(ev.partial)?.text;
      if (typeof text === 'string') u.feed(text);
    } else {
      u.end(String(ev.input?.text ?? ''));
    }
  }

  /**
   * speak with voice on (spec §7.1, §10.1): plays what streamed in, then listens, unless sleep came
   * in the same reply. @param {string} text @param {any} call
   * @returns {Promise<import('./tools.js').ToolOutput | string>}
   */
  async #say(text, call) {
    const voice = /** @type {import('../voice/voice.js').Voice} */ (this.voice);
    let u = this.#utterances.get(call.id);
    this.#utterances.delete(call.id);
    if (!u) {
      u = voice.speaker.begin();
      if (this.#cut) u.stop();
    }
    if (!u.stopped) {
      this.#closeEar('speaking');
      this.#setState('speaking');
    }
    u.end(text);
    const spoken = await u.done;
    if (spoken.failed) {
      await this.#notice(spoken.failed === 'blocked'
        ? { tone: 'info', title: 'Tap the screen so Shiori can speak', body: 'This browser plays sound only after a tap. Her words are in the conversation.' }
        : { tone: 'warn', title: "Shiori couldn't speak aloud", body: 'No voice in Settings → Models → Speech out worked; the Trace says why. Her words are in the conversation.' });
      return unspoken(spoken.failed);
    }
    if (spoken.cut) this.#cut = true;
    const before = spokenText(spoken);
    if (call.sleeping) return spoken.cut ? `${before} The microphone is open: what they say next wakes you.` : before;
    const { silenceSeconds } = await voice.settings();
    return this.#answer(before, await this.#listenFor(call.id, 'wait', silenceSeconds), call, `Heard nothing (${silenceSeconds} seconds).`);
  }

  /**
   * ask with voice on (spec §7.1): the question is spoken; the answer is a tap, typing, or speech.
   * Listening stops after the silence limit; the buttons keep waiting.
   * @param {string} question @param {any} call
   */
  async #askAloud(question, call) {
    const voice = /** @type {import('../voice/voice.js').Voice} */ (this.voice);
    const u = voice.speaker.begin();
    this.#closeEar('speaking');
    this.#setState('speaking');
    u.end(question);
    const spoken = await u.done;
    /** @type {Got} */
    let got = spoken.failed ? {} : await this.#listenFor(call.id, 'ask', (await voice.settings()).silenceSeconds);
    if (got.heard || got.dismissed || got.text !== undefined || got.chosen !== undefined || got.stopped) {
      if (got.chosen === undefined) return this.#answer('', got, call, '');
    } else {
      if (this.#ear?.owner === 'turn') this.#closeEar();
      got = await this.#waitFor(call.id, 'ask', 0);
    }
    if (got.stopped) return { content: STOPPED, isError: true };
    if (got.chosen !== undefined) {
      await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id }, texts: [['text', got.chosen]] });
      return `The user chose: ${got.chosen}`;
    }
    return this.#answer('', got, call, '');
  }

  /**
   * What a listen got, as a tool's result (spec §7.1). Heard speech is written to the log and
   * follows the result. @param {string} before what speak says happened first ('' for wait and ask)
   * @param {Got} got @param {any} call @param {string} silence the words for nothing heard
   * @returns {Promise<import('./tools.js').ToolOutput | string>}
   */
  async #answer(before, got, call, silence) {
    const lead = before ? `${before} ` : '';
    if (got.stopped) return { content: STOPPED, isError: true };
    if (got.heard) {
      await this.#logHeard(got.heard, { wake: call.wake, answer: call.id, gate: got.gate });
      return { content: `${lead}The user said:`, heard: [got.heard.id] };
    }
    if (got.dismissed) {
      await this.#logHeard(got.dismissed, { wake: call.wake, answer: call.id, dismissed: true, gate: 'chatter' });
      return { content: `${lead}Someone spoke, but not to you; it is below. You went back to sleep.`, heard: [got.dismissed.id], endTurn: true };
    }
    if (got.text !== undefined) {
      await this.#log({ type: 'msg.user', actor: 'user', data: { wake: call.wake, answer: call.id }, texts: [['text', got.text]] });
      return `${lead}The user wrote: ${got.text}`;
    }
    if (got.deaf) return `${lead}annai couldn't listen: ${got.deaf} The user may type.`;
    return `${lead}${silence}`;
  }

  /**
   * Listens for the user's answer (spec §10.4): the first thing heard, typing, or a tap; or a
   * silence of seconds. Speech heard before isn't an answer: it reaches her as heard while she was
   * thinking. @param {string} id @param {'wait' | 'ask'} kind @param {number} seconds @returns {Promise<Got>}
   */
  async #listenFor(id, kind, seconds) {
    const typed = this.#queue.findIndex((w) => w.kind === 'user' && w.scope === this.scope);
    if (typed >= 0) return { text: this.#queue.splice(typed, 1)[0].text };
    const deaf = await this.#openEar('turn');
    if (deaf) return { deaf };
    this.#setState('listening');
    return new Promise((resolve) => {
      /** @type {any} */
      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.#pending?.id !== id) return;
          this.#pending = null;
          resolve({});
        }, seconds * this.secondMs);
      };
      this.#pending = { id, kind, listening: true, arm, hold: () => clearTimeout(timer), resolve: (v) => { clearTimeout(timer); resolve(v); } };
      arm();
    });
  }

  /**
   * Opens the listening window (spec §10.2, §10.4) if voice can listen: recording or phone
   * dictation, as the speech-in list says. A window already open stays as it is.
   * @param {'tap' | 'turn'} owner @returns {Promise<string | null>} null when listening; otherwise why not
   */
  #openEar(owner) {
    const run = this.#earLock.then(() => this.#openEarNow(owner));
    this.#earLock = run.catch(() => {});
    return run;
  }

  /** @param {'tap' | 'turn'} owner @returns {Promise<string | null>} */
  async #openEarNow(owner) {
    const voice = this.voice;
    if (!voice) return "voice isn't available here.";
    if (this.#ear) return null; // a tap's window stays the tap's until the first thing said: that needs no gate (choice 3)
    const how = await voice.howToListen();
    if (!how.kind) return how.why;
    /** @type {{ owner: 'tap' | 'turn', session: { stop(): void } | null }} */
    const ear = { owner, session: null };
    this.#ear = ear;
    try {
      const session = await voice.open({
        kind: how.kind,
        onSegment: (h) => this.#heard(h),
        onSpeech: () => this.#speechStarted(),
        onQuiet: () => this.#speechStopped(),
        onError: (e) => this.#earFailed(e),
      });
      if (this.#ear === ear) ear.session = session;
      else session.stop(); // closed while it opened
      return null;
    } catch (e) {
      if (this.#ear === ear) this.#ear = null;
      return `${voice.problem(e).title}.`;
    }
  }

  /** Closes the listening window; speech still going on becomes a segment first. @param {'playback' | 'speaking'} [next] */
  #closeEar(next = 'playback') {
    clearTimeout(this.#quiet);
    const ear = this.#ear;
    if (!ear) return;
    this.#ear = null;
    ear.session?.stop();
    if (next === 'playback') this.voice?.platform?.session('playback'); // full-quality Bluetooth audio again (spec §10.1)
  }

  /** What the microphone heard (spec §10.4), handled in order. @param {Heard} h */
  #heard(h) {
    this.#hearing = this.#hearing.then(() => this.#route(h)).catch((e) => { console.warn('heard speech was not handled', e); });
  }

  /**
   * Where a segment goes (spec §10.4): the answer she listens for; a tap's first words, which wake
   * her; or, while she works, her next call ("heard while you were thinking"), which a new turn
   * takes if this one ends first: nothing heard is lost. @param {Heard} h
   */
  async #route(h) {
    const tapped = this.#ear?.owner === 'tap';
    const p = this.#pending?.listening ? this.#pending : null;
    if (p) {
      const verdict = tapped ? null : await this.#gate(h);
      if (this.#pending === p) {
        this.#pending = null;
        if (this.#ear) this.#ear.owner = 'turn';
        this.#setState('thinking');
        p.resolve(verdict === 'chatter' ? { dismissed: h } : { heard: h, ...(verdict ? { gate: verdict } : {}) });
        return;
      }
    }
    if (tapped && !this.#busy) {
      // A tap's window: the first thing said wakes her, and the window is the turn's from then on.
      clearTimeout(this.#quiet);
      if (this.#ear) this.#ear.owner = 'turn';
      this.#push({ kind: 'heard', text: '', heard: h });
      this.#drain();
      return;
    }
    const verdict = await this.#gate(h);
    if (this.state.name === 'hearing') this.#setState(this.#busy ? 'thinking' : 'listening');
    this.#push({ kind: 'heard', text: '', heard: h, ...(verdict ? { gate: verdict } : {}) });
    this.#drain();
  }

  /**
   * The quick-decision gate for one segment (spec §10.4). It runs only when a quick-decision model
   * is configured; without one there is no gate, and what was heard goes to the main model.
   * @param {Heard} _h @returns {Promise<'shiori' | 'chatter' | 'unsure' | null>} null: no gate ran
   */
  async #gate(_h) {
    return null;
  }

  /** Someone started speaking: Hearing you, and no silence limit while they speak. */
  #speechStarted() {
    clearTimeout(this.#quiet);
    this.#pending?.hold?.();
    if (!this.voice?.speaker.speaking) this.#setState('hearing');
  }

  /** What began like speech wasn't (a click): the silence limit starts again. */
  #speechStopped() {
    this.#pending?.arm?.();
    const tapped = this.#ear?.owner === 'tap' && !this.#busy;
    if (tapped) this.#armQuiet();
    if (this.state.name === 'hearing') this.#setState(this.#pending?.listening || tapped ? 'listening' : 'thinking');
  }

  /** The microphone stopped while listening (another app took it, say): a card says why, and a wait for an answer ends. @param {Error} e */
  #earFailed(e) {
    const problem = this.voice?.problem(e) ?? { title: 'Listening stopped', body: String(e?.message ?? e) };
    this.#closeEar();
    this.#notice({ tone: 'warn', title: problem.title, body: problem.body });
    const p = this.#pending?.listening ? this.#pending : null;
    if (p) {
      this.#pending = null;
      p.resolve({ deaf: `${problem.title}.` });
    }
  }

  /**
   * Tapping Shiori (spec §6.7, §10.4): while she speaks, stops her, keeps where, and opens the
   * microphone; while she listens, stops listening and her turn; while she works, stops her turn;
   * otherwise, with voice on, starts listening (and with voice off, typing opens).
   * @returns {'cut' | 'stopped' | 'listening' | 'typing'}
   */
  tap() {
    const voiceOn = Boolean(this.voice?.on);
    if (this.voice?.speaker.speaking) {
      this.voice.speaker.stop();
      for (const u of this.#utterances.values()) u.stop();
      this.#cut = true;
      if (voiceOn) this.#tapListen();
      return 'cut';
    }
    const s = this.state.name;
    if (s === 'listening' || s === 'hearing') {
      this.#closeEar();
      if (this.#busy) this.interrupt();
      else this.#setState(this.online() ? 'sleeping' : 'offline');
      return 'stopped';
    }
    if (s === 'thinking' || s === 'away') {
      this.interrupt();
      return 'stopped';
    }
    if (!voiceOn) return 'typing';
    this.#tapListen();
    return 'listening';
  }

  /** The user tapped to talk (spec §10.4): the microphone opens; a silence closes it again. */
  #tapListen() {
    this.#openEar('tap').then(async (deaf) => {
      if (deaf) {
        await this.#notice({ tone: 'warn', title: "Shiori can't hear you yet", body: deaf });
        return;
      }
      const p = this.#pending;
      if (p?.kind === 'ask') p.listening = true; // an ask's answer may be spoken
      if (this.#busy) return; // she is speaking or working: the window serves her turn
      this.#setState('listening');
      this.#armQuiet();
    });
  }

  /** A tap's window that hears nothing closes after the silence limit. */
  async #armQuiet() {
    clearTimeout(this.#quiet);
    const seconds = this.voice ? (await this.voice.settings()).silenceSeconds : 8;
    clearTimeout(this.#quiet);
    this.#quiet = setTimeout(() => {
      if (this.#ear?.owner !== 'tap' || this.#busy) return;
      this.#closeEar();
      this.#setState(this.online() ? 'sleeping' : 'offline');
    }, seconds * this.secondMs);
  }

  /** The end of a turn: speech streamed but never said stops; the microphone closes unless the user tapped to talk (spec §6.2, §10.4). */
  async #afterTurn() {
    for (const u of this.#utterances.values()) u.stop();
    this.#utterances.clear();
    if (this.#ear?.owner === 'turn') this.#closeEar();
    else if (!this.#ear && this.#voiceNow) this.voice?.platform?.session('playback'); // after speaking (spec §10.1)
  }

  /**
   * Writes what was heard (spec §10.2: transcripts go into the log). @param {Heard} h
   * @param {{ wake?: string, meanwhile?: boolean, answer?: string, dismissed?: boolean, gate?: string }} o
   * @param {(ev: Parameters<typeof record>[2]) => Promise<unknown>} [log]
   */
  async #logHeard(h, o, log = (ev) => this.#log(ev)) {
    await log({
      type: 'heard', actor: 'user',
      data: {
        id: h.id, ...(o.wake ? { wake: o.wake } : {}), ms: h.ms, source: h.source, ...(typeof h.text === 'string' ? { text: h.text } : {}),
        ...(o.meanwhile ? { meanwhile: true } : {}), ...(o.answer ? { answer: o.answer } : {}), ...(o.dismissed ? { dismissed: true } : {}), ...(o.gate ? { gate: o.gate } : {}),
      },
    });
  }
```

In `sw.js`, add `'/src/core/agent/listen.js',` to `SHELL` after `'/src/core/agent/instructions.js',`.

- [ ] **Step 6: Run the tests**

Run: `node --test test/unit/agent-voice.test.js`
Expected: PASS, 12 tests. A test that fails on timing (a state it polls for that comes and goes too fast) is a test to fix by waiting on what the test means (an event, a request count), never by a longer sleep; note it in the commit.
Run: `npm test 2>&1 | tail -5`
Expected: all pass: the voice-off paths behave as before (`agent-loop.test.js`).

- [ ] **Step 7: Commit**

```bash
npm run stamp && npm run check && git add src/core/agent src/core/voice test/unit sw.js && git commit -m "Shiori speaks and listens: speak plays as it streams and then listens, wait listens, ask is spoken, and a tap stops her or starts listening (spec §7.1, §10.1, §10.4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 6: Words written down, clips kept, and listening that can't happen

**Files:**
- Modify: `src/core/agent/loop.js`
- Test: `test/unit/agent-voice-after.test.js`

**Interfaces:**
- Consumes: `voice.writeDown`, `voice.memory`, `voice.settings().keepClips`, `voice.problem` (Task 3); `transcript.unwritten()` (Task 4); the loop of Task 5.
- Produces:
  - After a turn in which a model answered and none failed, every heard segment of the conversation that is still in memory gets a `heard.text` event (its words, or `[audio, not transcribed]`, and who wrote them down), and leaves memory. After a failed turn, memory keeps it.
  - With "keep voice clips" on, a `heard` event names its WAV clip in `refs` and `data.clip`.
  - When listening can't happen: no usable speech-in entry → a card "Shiori can't hear you yet" saying what to add (on every tap; once for a turn's listening until listening works again); a microphone that fails to open → a card with this phone's steps (§17 rule 3).

- [ ] **Step 1: Write the failing test**

`test/unit/agent-voice-after.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { WRITE_DOWN } from '../../src/core/voice/voice.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const speakOnly = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }] });
/** Taps Shiori and says one of the clips. @param {any} k @param {string} name */
async function tapAndSay(k, name) {
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, name);
  await k.agent.idle();
}

test('after a turn that worked, what was heard is written down and its sound let go; later turns send the words (spec §10.3)', async () => {
  const k = await agentKit([[say('Tacos are close.'), say('Still tacos.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
  await tapAndSay(k, 'where-eat');
  const [written] = await k.events(['heard.text']);
  const [heard] = await k.events(['heard']);
  assert.deepEqual([written.data.of, written.data.text, written.data.by], [heard.data.id, 'where should we eat', 'ears']);
  assert.equal(k.voice.memory.size, 0);
  k.agent.send('And again?');
  await k.agent.idle();
  assert.deepEqual(k.transcribed, ['m-hear'], 'the transcript made for the reply was reused, and not made again');
  assert.deepEqual(k.requests[1].messages[0].parts.slice(0, 2), [{ type: 'text', text: '[heard]' }, { type: 'text', text: 'where should we eat' }]);
});

test('sound sent to a model that takes audio is written down by that model, after the turn (spec §10.3)', async () => {
  const k = await agentKit([[say('Tacos are close.'), { text: 'where should we eat' }]], { models: [{ input: ['text', 'image', 'audio'] }], voice: { speechIn: ['send-audio'] } });
  await tapAndSay(k, 'where-eat');
  assert.equal(k.requests[0].messages[0].parts[1].type, 'audio');
  assert.equal(k.requests[1].system, WRITE_DOWN);
  assert.deepEqual(k.requests[1].messages[0].parts.map((/** @type {any} */ p) => p.type), ['audio']);
  const [written] = await k.events(['heard.text']);
  assert.deepEqual([written.data.text, written.data.by], ['where should we eat', 'model-0']);
  assert.deepEqual(k.transcribed, []);
});

test('a turn that fails keeps what was heard; the next one still has the words, transcribed once (spec §10.3)', async () => {
  const k = await agentKit([[{ error: 'bad-request', status: 400 }, say('Now I hear you.')]], { voice: { speechIn: ['m-hear'], hears: ['find a gas station'] } });
  await tapAndSay(k, 'gas-station');
  assert.equal(k.notices.at(-1)?.title, "Shiori can't reach her model");
  assert.equal((await k.events(['heard.text'])).length, 0);
  assert.equal(k.voice.memory.size, 1);
  k.agent.send('Try again');
  await k.agent.idle();
  assert.match(JSON.stringify(k.requests[1].messages), /find a gas station/);
  assert.deepEqual(k.transcribed, ['m-hear']);
  assert.equal((await k.events(['heard.text'])).length, 1);
  assert.equal(k.voice.memory.size, 0);
});

test('keep voice clips: each clip is kept with the conversation, named by its heard event; off by default (spec §10.2, §4.9)', async () => {
  const kept = await agentKit([[say('Noted.')]], { voice: { speechIn: ['m-hear'], keepClips: true } });
  await tapAndSay(kept, 'where-eat');
  const [heard] = await kept.events(['heard']);
  assert.match(heard.data.clip, /^[0-9a-f]{64}$/);
  assert.deepEqual(heard.refs, [heard.data.clip]);
  const blob = await kept.store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.getBlob(heard.data.clip));
  assert.equal(blob?.type, 'audio/wav');
  const plain = await agentKit([[say('Noted.')]], { voice: { speechIn: ['m-hear'] } });
  await tapAndSay(plain, 'where-eat');
  const [unkept] = await plain.events(['heard']);
  assert.equal(unkept.data.clip, undefined);
  assert.equal(unkept.refs, undefined);
  const types = [];
  for (const b of await plain.store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.listBlobs())) types.push((await plain.store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.getBlob(b.hash)))?.type);
  assert.ok(!types.some((t) => String(t).startsWith('audio/')), 'no sound is stored');
});

test('after a reload, the conversation has the same heard speech (spec §6.7)', async () => {
  const k = await agentKit([[speakOnly('Want tacos?'), say('Done.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat', 'yes'] } });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await until(() => k.agent.state.name === 'listening' && k.requests.length === 1);
  await hear(k, 'first-one');
  await k.agent.idle();
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, k.agent.transcript.messages);
});

test("no usable entry: a tap says what to add; speak says it couldn't listen, without a card each time (spec §10.3)", async () => {
  const k = await agentKit([[speakOnly('Hello?'), speakOnly('Still there?'), { toolCalls: [{ name: 'sleep', input: {} }] }]], { voice: { speechIn: [] } });
  assert.equal(k.agent.tap(), 'listening');
  await until(() => k.notices.length === 1);
  assert.equal(k.notices[0].title, "Shiori can't hear you yet");
  assert.match(k.notices[0].body, /speech-in list is empty/);
  k.agent.send('Hi');
  await k.agent.idle();
  const speaks = (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === 'speak');
  assert.match(speaks[0].data.content, /^Said aloud\. annai couldn't listen: Shiori can't hear you: the speech-in list is empty\./);
  assert.equal(k.notices.length, 1);
  assert.equal(k.platform.opens, 0);
});

test('a microphone that is refused: a card with this phone’s steps (spec §17 rule 3)', async () => {
  const k = await agentKit([[say('x')]], { voice: { micFails: 'NotAllowedError' } });
  k.agent.tap();
  await until(() => k.notices.length === 1);
  assert.equal(k.notices[0].title, "annai can't use the microphone");
  assert.match(k.notices[0].body, /Settings → Apps → Safari → Microphone/);
  assert.equal(k.agent.state.name, 'sleeping');
});

test('phone dictation in the loop: its words need no transcription; when it fails, recording takes over (spec §10.3)', async () => {
  const k = await agentKit([[say('A gas station is 2 miles on.'), say('And a café.')]], { voice: { dictation: true, speechIn: ['dictation', 'm-hear'], hears: ['and a coffee'] } });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  k.platform.dictation.say('is there a gas station nearby');
  await k.agent.idle();
  assert.deepEqual(k.requests[0].messages[0].parts.slice(0, 2), [{ type: 'text', text: '[heard]' }, { type: 'text', text: 'is there a gas station nearby' }]);
  assert.deepEqual(k.transcribed, []);
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  k.platform.dictation.fail('network');
  await until(() => k.platform.log.includes('mic open'));
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.deepEqual(k.transcribed, ['m-hear']);
  assert.match(JSON.stringify(k.requests[1].messages.at(-1)), /and a coffee/);
});
```

(The last two tests pin what Tasks 3 and 5 built together; the dictation test may pass before this task's code. Run it anyway, and read its output.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/agent-voice-after.test.js`
Expected: FAIL: no `heard.text` events, no clip, and no card for an empty speech-in list.

- [ ] **Step 3: Write the implementation**

In `src/core/agent/loop.js`:

1. Import `NOT_TRANSCRIBED` from `'../voice/resolve.js'`.
2. Add a field: `/** A card said she can't hear: until listening works again, it isn't said again for every speak. */ #toldDeaf = false;`
3. In `#turn`, add `let answered = false;` and `let failed = false;` before the `try`; set `answered = true;` after `this.#heardBy = result.modelId;`; set `failed = true;` before each `break` that follows `await this.#failed(e, wakeId);` or a `#tidyUp` that returned `null`; the `finally` calls `this.#afterTurn(answered && !failed, wakeId)`.
4. Replace `#afterTurn` with:

```js
  /**
   * The end of a turn: speech streamed but never said stops; the microphone closes unless the user
   * tapped to talk (spec §6.2, §10.4); after a turn that worked, what was heard is written down.
   * @param {boolean} ok @param {string} wakeId
   */
  async #afterTurn(ok, wakeId) {
    for (const u of this.#utterances.values()) u.stop();
    this.#utterances.clear();
    if (this.#ear?.owner === 'turn') this.#closeEar();
    else if (!this.#ear && this.#voiceNow) this.voice?.platform?.session('playback'); // after speaking (spec §10.1)
    if (ok) await this.#writeDown(wakeId);
  }

  /**
   * The words of what was heard are written down, and the sound is let go (spec §10.3: each
   * segment stays in memory until the turn that used it succeeds; text versions are made then, the
   * last time the sound is at hand). @param {string} wakeId
   */
  async #writeDown(wakeId) {
    const voice = this.voice;
    if (!voice) return;
    for (const id of this.transcript.unwritten()) {
      if (!voice.memory.get(id)) continue;
      const r = await voice.writeDown(id, { scope: this.scope, wake: wakeId, ...(this.#heardBy ? { hearer: this.#heardBy } : {}) }).catch(() => null);
      await this.#log({ type: 'heard.text', actor: 'system', data: { of: id, wake: wakeId, text: r ? r.text : NOT_TRANSCRIBED, by: r?.by ?? null } });
      voice.memory.drop(id);
    }
  }
```

5. In `#logHeard`, before the `log(…)` call, add

```js
    // The sound is kept only with "keep voice clips" (spec §10.2), as a blob the event names (§4.9).
    const keep = h.audio && this.voice ? (await this.voice.settings()).keepClips : false;
    const clip = keep && h.audio ? await sha256Hex(h.audio.data) : undefined;
```

   give the event's data `...(clip ? { clip } : {})`, and pass `blobs: clip && h.audio ? [{ hash: clip, bytes: h.audio.data, type: 'audio/wav' }] : []`.
6. In `#openEarNow`, replace `if (!how.kind) return how.why;` with:

```js
    if (!how.kind) {
      // The mic button explains what to add (spec §10.3): on every tap, and once for her own listening.
      if (owner === 'tap' || !this.#toldDeaf) await this.#notice({ tone: 'warn', title: "Shiori can't hear you yet", body: how.why });
      this.#toldDeaf = true;
      return how.why;
    }
```

   after `if (this.#ear === ear) ear.session = session;` set `this.#toldDeaf = false;`, and replace the `catch` block's body with:

```js
      if (this.#ear === ear) this.#ear = null;
      const problem = voice.problem(e); // denied: steps for this phone (spec §17 rule 3)
      await this.#notice({ tone: 'warn', title: problem.title, body: problem.body });
      return `${problem.title}.`;
```

7. In `#tapListen`, the `if (deaf) { … }` block becomes `if (deaf) return; // the card said why`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/agent-voice-after.test.js test/unit/agent-voice.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/agent/loop.js test/unit/agent-voice-after.test.js && git commit -m "After a turn that worked, what was heard is written down and its sound let go; voice clips kept only when asked; a card says why listening can't happen (spec §10.2, §10.3, §17)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 7: The quick-decision gate

**Files:**
- Create: `src/core/voice/gate.js`
- Modify: `src/core/agent/loop.js`, `sw.js`
- Test: `test/unit/agent-voice-gate.test.js`

**Interfaces:**
- Consumes: `llm.gate` (Task 1); the loop's `#route`, `#askAloud`, `#say` (Tasks 5, 6).
- Produces:
  - `gate.js`: `GATE_OPTIONS` (`shiori`, `chatter`), `gatePrompt(lastSaid): string`.
  - The gate runs on what is heard (not a tap's first words) when the decide role has its own models: `shiori` and `unsure` reach the main model (the `heard` event notes the verdict); `chatter` after `speak` or `wait` ends the turn ("record it and sleep"); chatter while she thinks is written in at her next step (`heard` with `dismissed` and `meanwhile`) and wakes nothing; chatter during an `ask` is written in and the buttons keep waiting. A gate that fails counts as `unsure`.

- [ ] **Step 1: Write the failing test**

`test/unit/agent-voice-gate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until, hear } from './agent-kit.js';

const choose = (/** @type {'A' | 'B'} */ letter) => ({ toolCalls: [{ name: 'decide', input: { option: letter } }] });
const speakOnly = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }] });
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
/** The main model's requests, not the gate's. @param {any} k */
const mainRequests = (k) => k.requests.filter((/** @type {any} */ r) => !String(r.system ?? '').startsWith('You make one quick decision'));
/** The gate's requests. @param {any} k */
const gateRequests = (k) => k.requests.filter((/** @type {any} */ r) => String(r.system ?? '').startsWith('You make one quick decision'));

test('chatter after she speaks is recorded, and she goes back to sleep without a call (spec §10.4)', async () => {
  const k = await agentKit([[speakOnly('Bixby Bridge is ahead.')]], { voice: { decide: [choose('B')], speechIn: ['m-hear'], hears: ['turn the radio down'] } });
  k.agent.send('What is ahead?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await k.agent.idle();
  const speak = (await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'speak');
  assert.equal(speak.data.content, 'Said aloud. Someone spoke, but not to you; it is below. You went back to sleep.');
  const [heard] = await k.events(['heard']);
  assert.deepEqual([heard.data.dismissed, heard.data.answer, heard.data.gate], [true, speak.data.id, 'chatter']);
  assert.equal(mainRequests(k).length, 1, 'no call for chatter');
  assert.match(JSON.stringify(gateRequests(k)[0].messages), /turn the radio down/);
  assert.match(gateRequests(k)[0].messages[0].parts[0].text, /She last said aloud: "Bixby Bridge is ahead\."/);
  assert.equal(k.platform.log.at(-1), 'mic close');
  assert.equal(k.agent.state.name, 'sleeping');
});

test('meant for Shiori, or unsure: it reaches the main model (spec §10.4)', async () => {
  for (const [decide, gate] of [[[choose('A')], 'shiori'], [[{ error: 'bad-request', status: 400 }], 'unsure']]) {
    const k = await agentKit([[speakOnly('Want tacos?'), say('Tacos it is.')]], { voice: { decide, speechIn: ['m-hear'], hears: ['yes please'] } });
    k.agent.send('Lunch?');
    await until(() => k.agent.state.name === 'listening');
    await hear(k, 'first-one');
    await k.agent.idle();
    assert.equal(mainRequests(k).length, 2, String(gate));
    assert.equal((await k.events(['heard']))[0].data.gate, gate);
  }
});

test("a tap's first words need no gate; without a quick-decision model there is none", async () => {
  const k = await agentKit([[say('Sure.')]], { voice: { decide: [choose('B')], speechIn: ['m-hear'] } });
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await k.agent.idle();
  assert.equal(gateRequests(k).length, 0);
  assert.equal(mainRequests(k).length, 1);
  const plain = await agentKit([[speakOnly('Want tacos?'), say('OK.')]], { voice: { speechIn: ['m-hear'] } });
  plain.agent.send('Lunch?');
  await until(() => plain.agent.state.name === 'listening');
  await hear(plain, 'first-one');
  await plain.agent.idle();
  assert.equal((await plain.events(['heard']))[0].data.gate, undefined);
  assert.equal(mainRequests(plain).length, 2);
});

test('chatter while she thinks is written in at her next step, and wakes nothing (spec §10.4)', async () => {
  const k = await agentKit([[
    speakOnly('Want tacos?'),
    { delayMs: 120, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] },
    say('Tacos, noted.'),
  ]], { voice: { decide: [choose('A'), choose('B')], speechIn: ['m-hear'], hears: ['yes please', 'did you lock the car'] } });
  k.agent.send('Lunch?');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'first-one');
  await until(() => mainRequests(k).length === 2);
  await hear(k, 'gas-station');
  await k.agent.idle();
  assert.equal(mainRequests(k).length, 3, 'chatter wakes no turn of its own');
  assert.deepEqual(mainRequests(k)[2].messages.at(-1).parts.slice(-2), [{ type: 'text', text: '[heard, not meant for you]' }, { type: 'text', text: 'did you lock the car' }]);
  const chatter = (await k.events(['heard']))[1];
  assert.deepEqual([chatter.data.dismissed, chatter.data.meanwhile], [true, true]);
});

test('chatter during an ask is written in, and the buttons keep waiting (spec §10.4)', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } }] },
    say('Kept.'),
  ]], { voice: { decide: [choose('B')], speechIn: ['m-hear'], hears: ['pass the water'] } });
  k.agent.send('We are late');
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-lunch');
  await until(() => k.agent.state.name === 'waiting');
  const ask = (await k.events(['tool.call'])).find((/** @type {any} */ e) => e.data.name === 'ask');
  k.agent.answer(ask.data.id, 'Keep it');
  await k.agent.idle();
  assert.equal((await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'ask').data.content, 'The user chose: Keep it');
  const heard = await k.events(['heard']);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].data.dismissed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/agent-voice-gate.test.js`
Expected: FAIL: the chatter reaches the main model (`mainRequests(k).length` is 2) and no gate request is made.

- [ ] **Step 3: Write the implementation**

`src/core/voice/gate.js`:

```js
/**
 * The quick-decision gate's question (spec §10.4): is what the microphone heard meant for Shiori?
 * What was heard follows the question, resolved for the decision model like any heard speech.
 */
export const GATE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'shiori', label: 'Meant for Shiori: said to her, or answering her' }),
  Object.freeze({ id: 'chatter', label: 'Not meant for her: people talking among themselves, a phone call, the radio' }),
]);

/** @param {string} lastSaid what she said aloud last ('' when nothing yet) */
export function gatePrompt(lastSaid) {
  return [
    "Shiori is a travel guide in a phone app. She listens through the phone's microphone, often in a car with other people.",
    lastSaid ? `She last said aloud: "${lastSaid.slice(0, 300)}"` : 'She has said nothing aloud yet.',
    'What the microphone heard comes after the options. Is it meant for Shiori?',
  ].join('\n');
}
```

In `src/core/agent/loop.js`:

1. Import `{ GATE_OPTIONS, gatePrompt }` from `'../voice/gate.js'`.
2. Fields: `/** Heard while she worked and judged not meant for her: written at her next step. @type {Heard[]} */ #chatter = [];` and `/** What she said aloud last, for the gate. */ #lastSaid = '';`.
3. Replace `#gate` with:

```js
  /**
   * The quick-decision gate for one segment (spec §10.4). It runs only when a quick-decision model
   * is configured (falling back to the main model would double the calls): what was heard goes to
   * the decide role, as audio or words like any speech. A gate that fails is unsure.
   * @param {Heard} h @returns {Promise<'shiori' | 'chatter' | 'unsure' | null>} null: no gate ran
   */
  async #gate(h) {
    const cfg = await this.llm.config();
    if (!cfg.roles?.decide?.models?.length || !this.llm.gate || !this.voice) return null;
    try {
      const r = await this.llm.gate({
        prompt: gatePrompt(this.#lastSaid), options: GATE_OPTIONS, scope: this.scope, speech: this.voice.resolver(this.scope),
        parts: [{ type: 'speech', id: h.id, ...(typeof h.text === 'string' ? { text: h.text } : {}) }],
      });
      if (r.by === 'unsure') return 'unsure';
      return (r.probabilities.chatter ?? 0) > (r.probabilities.shiori ?? 0) ? 'chatter' : 'shiori';
    } catch {
      return 'unsure'; // the gate never loses speech: unsure goes to the main model
    }
  }

  /** Chatter heard while she worked, written in now (spec §10.4: dismissed speech still goes into the transcript). @param {string} wakeId */
  async #writeChatter(wakeId) {
    for (const h of this.#chatter.splice(0)) await this.#logHeard(h, { wake: wakeId, meanwhile: true, dismissed: true, gate: 'chatter' });
  }
```

4. In `#route`, replace

```js
    const verdict = await this.#gate(h);
    if (this.state.name === 'hearing') this.#setState(this.#busy ? 'thinking' : 'listening');
```

   with

```js
    const verdict = await this.#gate(h);
    if (this.state.name === 'hearing') this.#setState(this.#busy ? 'thinking' : 'listening');
    if (verdict === 'chatter') {
      // Chatter: recorded, and she sleeps on (spec §10.4).
      if (this.#busy) this.#chatter.push(h);
      else await this.#logHeard(h, { dismissed: true, gate: 'chatter' });
      return;
    }
```

5. In `#turn`, before `const more = this.#take();` add `await this.#writeChatter(wakeId);`; in `#afterTurn`, before `if (ok) …`, add `await this.#writeChatter(wakeId);`.
6. In `#say`, after `const spoken = await u.done;` add `this.#lastSaid = spoken.heard || text;`; in `#askAloud`, after its `await u.done`, add `this.#lastSaid = question;`, and after the `let got = …` line add:

```js
    if (got.dismissed) {
      this.#chatter.push(got.dismissed); // written in at her next step; the buttons keep waiting
      got = {};
    }
```

In `sw.js`, add `'/src/core/voice/gate.js',` to `SHELL` with the other `src/core/voice/` files.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/agent-voice-gate.test.js test/unit/agent-voice.test.js test/unit/agent-voice-after.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src/core/voice/gate.js src/core/agent/loop.js test/unit/agent-voice-gate.test.js sw.js && git commit -m "The quick-decision gate: what is heard goes to Shiori, or is recorded as chatter while she sleeps on (spec §10.4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---
### Task 8: The tap and the glow on the phone, the settings, and a spoken exchange end to end

**Files:**
- Create: `test/e2e/voice-talk.spec.js`
- Modify: `src/ui/dock.js`, `src/ui/screens/voice.js`, `src/app/main.js`, `docs/testing/device-checklist-m3.md`
- Test: `test/e2e/voice-talk.spec.js`, `test/e2e/voice-parts.spec.js`, `test/e2e/shiori.spec.js` (all still pass)

**Interfaces:**
- Consumes: `agent.tap()`, `agent.voice`, states `listening` and `hearing` (Task 5); `voice.onLevel`, `voice.refresh()` (3a, Task 3).
- Produces:
  - The dock's Shiori button calls `agent.tap()`; typing opens only when it answers `'typing'`. The seat's glow follows her voice while she speaks and yours while she hears you (§16.3).
  - Settings → Voice: radios "Voice" (`Auto`, `On`, `Off`), "Listen for an answer (seconds)", "Wait for her first words (seconds)", "Keep voice clips"; each saves at once and refreshes the voice.
  - `main.js` gives the `Voice` the store and this phone's kind, and the `Agent` the `Voice`.

- [ ] **Step 1: Write the failing test**

`test/e2e/voice-talk.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply, fakeMicrophone } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

const clipPath = (/** @type {string} */ name) => fileURLToPath(new URL(`../fixtures/voice/${name}.wav`, import.meta.url));
const wav = { status: 200, type: 'audio/wav', body: Buffer.from(encodeWav(Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin(i / 3)), 16000)) };
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const json = (/** @type {any} */ o) => ({ status: 200, type: 'application/json', body: JSON.stringify(o) });

test('a spoken back-and-forth: tap, ask aloud, hear her answer, answer her, and she goes back to sleep (spec §10)', async ({ page }) => {
  const server = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'There is a taco stand two miles ahead. Want to stop there?' } }])),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Great, I will tell you when to turn.' } }, { name: 'sleep', input: {} }])),
    ],
    '/ears/audio/transcriptions': [json({ text: 'Where should we eat?' }), json({ text: 'Yes, the first one.' })],
    '/voice/audio/speech': wav,
  });
  try {
    await fakeMicrophone(page, [clipPath('where-eat'), clipPath('first-one')]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${server.origin}/b`, key: 'sk-chat-test', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await addEndpoint(page, 'Other: OpenAI-compatible transcription', { name: 'Ears', url: `${server.origin}/ears`, key: 'sk-ears-test', model: 'ears' });
    await page.getByLabel('Add a model to speech-in').selectOption({ label: 'ears' });
    await page.getByRole('button', { name: 'Add to speech-in' }).click();
    await addEndpoint(page, 'Other: OpenAI-compatible voice', { name: 'Voice', url: `${server.origin}/voice`, key: 'sk-voice-test', model: 'voice' });
    await page.getByLabel('Add a model to speech-out').selectOption({ label: 'voice' });
    await page.getByRole('button', { name: 'Add to speech-out' }).click();
    await page.getByRole('button', { name: 'Move voice up' }).click();
    await page.goto('/#/voice');
    await page.getByRole('radio', { name: 'On', exact: true }).check();
    await expect(page.getByText('Voice is on.')).toBeVisible();
    await page.goto('/#/talk');
    const label = page.locator('.talk-label');
    await expect(label).toHaveText('Tap to talk');
    await page.getByRole('button', { name: 'Shiori' }).click();
    await expect(label).not.toHaveText('Tap to talk');
    await expect.poll(() => server.bodies('/voice/audio/speech').length, { timeout: 30_000 }).toBe(3);
    await expect(label).toHaveText('Tap to talk', { timeout: 30_000 });
    expect(server.bodies('/ears/audio/transcriptions')).toHaveLength(2);
    const [first, second] = server.bodies('/b/v1/messages');
    expect(JSON.stringify(first.messages)).toContain('Where should we eat?');
    const answer = JSON.stringify(second.messages.at(-1));
    expect(answer).toContain('The user said:');
    expect(answer).toContain('Yes, the first one.');
    expect(server.bodies('/voice/audio/speech').map((/** @type {any} */ b) => b.input)).toEqual(['There is a taco stand two miles ahead.', 'Want to stop there?', 'Great, I will tell you when to turn.']);
    expect(await page.evaluate(() => /** @type {any} */ (window).__micOpens)).toBe(2);
    await expect(page.locator('.convo .you')).toHaveText(['Where should we eat?', 'Yes, the first one.']);
    // Keep voice clips is off: nothing heard was kept as sound.
    const sounds = await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('annai');
      open.onsuccess = () => {
        const all = open.result.transaction('blobs').objectStore('blobs').getAll();
        all.onsuccess = () => resolve(all.result.filter((/** @type {any} */ b) => String(b.type).startsWith('audio/')).length);
      };
    }));
    expect(sounds).toBe(0);
  } finally {
    await server.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test test/e2e/voice-talk.spec.js --project=chromium`
Expected: FAIL: there is no radio "On" on the Voice screen.

- [ ] **Step 3: Write the implementation**

In `src/app/main.js`:
- import `platform` from `'../ui/platform.js'` (with the names already imported from there);
- the `Voice` becomes `new Voice({ llm, ws, registry, store, locale: navigator.language, where: platform() })`, followed by `voice.refresh().catch(() => {});`, and it moves above the `Agent`, which becomes `new Agent({ store, ws, llm, registry, codec, voice })`.

In `src/ui/dock.js`:
- the Shiori button's `onclick` becomes:

```js
    onclick: () => {
      // While she speaks, a tap stops her and listens; asleep with voice on, it listens; with voice off, typing opens (spec §10.4).
      if (ctx.agent.tap() === 'typing') openTyping();
    },
```

- after `ctx.agent.on('state', …)`, add:

```js
  // The glow follows the sound (spec §16.3): her voice while she speaks, yours while she hears you.
  ctx.voice?.onLevel((/** @type {number} */ x, /** @type {'her' | 'you'} */ who) => {
    const s = ctx.agent.state.name;
    if ((who === 'her' && s === 'speaking') || (who === 'you' && s === 'hearing')) avatar.setLevel(x, who);
  });
```

- the module comment's second sentence becomes: "Tapping Shiori stops her while she works or speaks (§6.7, §10.4), and starts listening while she rests with voice on; with voice off it opens typing."

In `src/ui/screens/voice.js`:
- import `radios`, `checkbox` from `'../dom.js'` (with `h`, `field`);
- after `const synth = …`, add:

```js
  /** Saves a voice setting and works out the voice again. @param {Record<string, any>} change @param {string} [said] */
  const save = async (change, said = 'Saved') => {
    await updateAppSettings(ctx.ws, { voice: change });
    await voice.refresh();
    ctx.notices.toast(said);
  };
  const modeStatus = h('p', { class: 'sub', role: 'status', text: voice.on ? 'Voice is on.' : 'Voice is off.' });
  const mode = radios('Voice', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], s.mode, async (m) => {
    await save({ mode: m });
    modeStatus.textContent = voice.on ? 'Voice is on.' : 'Voice is off.';
  });
  const silence = h('input', { id: 'voice-silence', type: 'number', min: '2', max: '60', step: '1', value: String(s.silenceSeconds) });
  silence.addEventListener('change', () => {
    const n = Math.round(Number(silence.value));
    if (n >= 2 && n <= 60) save({ silenceSeconds: n });
  });
  const firstWords = h('input', { id: 'voice-first-words', type: 'number', min: '5', max: '120', step: '1', value: String(s.firstWordsSeconds) });
  firstWords.addEventListener('change', () => {
    const n = Math.round(Number(firstWords.value));
    if (n >= 5 && n <= 120) save({ firstWordsSeconds: n });
  });
  const clips = checkbox('Keep voice clips', s.keepClips);
  clips.input.addEventListener('change', () => save({ keepClips: clips.input.checked }));
```

- insert a first section in the returned screen (after the intro paragraph):

```js
    section('Voice',
      h('p', { class: 'sub', text: 'On: Shiori speaks aloud and listens for your answer. Off: she writes, and you type. Auto works out which (in the car, with headphones) in the next version; until then it is Off.' }),
      mode, modeStatus,
      h('div', { class: 'row' }, field('Listen for an answer (seconds)', silence), field('Wait for her first words (seconds)', firstWords))),
```

- in the Listening section, after the microphone status, add:

```js
      clips.el,
      h('p', { class: 'sub', text: 'Off: what the microphone hears is sent to be written down, then let go. On: each clip is kept with the conversation, and in backups.' }),
```

In `docs/testing/device-checklist-m3.md`, add:

```markdown
## Talking with Shiori (milestone 3b)

- [ ] **A spoken exchange.** Settings → Voice → On. Tap Shiori and ask "Where should we eat?". The dock says Listening, then Hearing you while you speak (the glow follows your voice), then Thinking; she answers aloud (the glow follows hers) and listens; answer her; she replies and sleeps (Tap to talk). The microphone indicator is off whenever she sleeps.
- [ ] **Interrupting.** While she speaks, tap her: she stops at once and listens; what you say next is her answer. In the Trace, her speak result says where you stopped her.
- [ ] **Talking over her thinking.** After you answer, add a second thought while she is still thinking: her reply covers both.
- [ ] **Chatter.** With a quick-decision model set, while she listens after speaking, talk to someone else ("can you pass the water?"): she doesn't answer, and goes to sleep; the conversation shows "Heard, not for Shiori".
- [ ] **Phone dictation.** With Speech in set to Phone dictation first and no transcription model: a spoken exchange works (Android Chrome; and note what iPhone does, in Safari and in the installed app).
- [ ] **Send audio to the model.** With an audio model (Gemini through OpenRouter, say) as main and "Send audio to the model" first: a spoken exchange works without a transcription model; in the conversation your words appear after her reply.
- [ ] **No way to hear.** With a text-only main model and only "Send audio to the model" in Speech in, tap Shiori: a card says what to add.
- [ ] **Silent switch.** iPhone silent switch on: does she still speak? (§10.1's "transient" session is muted by it; write down what happens.)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx playwright test test/e2e/voice-talk.spec.js test/e2e/voice-parts.spec.js test/e2e/shiori.spec.js --project=chromium`
Expected: PASS.
Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/voice-talk.spec.js test/e2e/voice-parts.spec.js test/e2e/shiori.spec.js --project=webkit`
Expected: PASS.
Run: `npm run stamp && npm run check`, then the whole e2e suite in both browsers.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add src test docs sw.js && git commit -m "On the phone: the tap stops, listens or types, the glow follows each voice, Settings → Voice turns voice on, and a spoken exchange works end to end (spec §10, §16.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
