import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRealtimeServer, GEMINI_PATH } from '../fakes/realtime-server.js';

const KEY = 'AIza-stand-in-key-0123456789';
const MODEL = 'models/gemini-3.8-live';
/** 0.1 s of 24 kHz PCM16: a ramp, so its bytes can be told apart. */
const AUDIO = Uint8Array.from({ length: 4800 }, (_, i) => i % 251);

/**
 * A client of the stand-in: Node's own WebSocket, as the unit tests use it. Every message the server sends is
 * parsed (Gemini sends its JSON in binary frames), and a close is kept.
 * @param {string} url @param {string[]} [protocols]
 */
function client(url, protocols = []) {
  const ws = new WebSocket(url, protocols);
  ws.binaryType = 'arraybuffer';
  /** @type {{ binary: boolean, json: any }[]} */
  const got = [];
  /** @type {(() => void)[]} */
  const waiting = [];
  /** @type {{ code: number, reason: string } | null} */
  let closed = null;
  ws.onmessage = (e) => {
    const binary = typeof e.data !== 'string';
    got.push({ binary, json: JSON.parse(binary ? new TextDecoder().decode(e.data) : e.data) });
    for (const w of waiting.splice(0)) w();
  };
  ws.onclose = (e) => {
    closed = { code: e.code, reason: e.reason };
    for (const w of waiting.splice(0)) w();
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return {
    ws, got, opened,
    get closed() { return closed; },
    /** @param {any} m */
    send: (m) => ws.send(JSON.stringify(m)),
    /** Waits until pred holds for what was received (or the close). @param {() => boolean} pred */
    async until(pred, ms = 5000) {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(got.map((g) => Object.keys(g.json)))}`);
        await new Promise((r) => { waiting.push(() => r(undefined)); setTimeout(r, 50); });
      }
    },
  };
}

const setup = (extra = {}) => ({ setup: { model: MODEL, generationConfig: { responseModalities: ['AUDIO'] }, realtimeInputConfig: { automaticActivityDetection: { disabled: true } }, ...extra } });

test('it speaks the Gemini Live flavour: setup, a turn on activityEnd, interrupted on activityStart, 1007 for a wrong key, and it records what it got', async () => {
  const s = await startRealtimeServer({
    flavour: 'gemini', key: KEY, pace: 0.05,
    turns: [
      { heard: 'Is Nepenthe open now?', said: "I'm checking.", audio: AUDIO, handle: 'h-1', usage: { promptTokenCount: 600, responseTokenCount: 30, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 400 }, { modality: 'AUDIO', tokenCount: 200 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 30 }] } },
      { said: 'Bixby Bridge is a concrete arch bridge, built in 1932, and the story goes on for a long while.', audio: new Uint8Array(48_000 * 4) },
    ],
  });
  try {
    assert.match(s.ws, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(s.origin, s.ws.replace('ws:', 'http:'));
    const c = client(`${s.ws}${GEMINI_PATH('v1alpha')}?key=${KEY}`);
    await c.opened;
    c.send(setup({ proactivity: { proactiveAudio: true } }));
    await c.until(() => c.got.some((g) => g.json.setupComplete));
    assert.ok(c.got.every((g) => g.binary), 'Gemini sends its JSON in binary frames');
    // A spoken turn: activityStart, audio, activityEnd; then the turn plays.
    c.send({ realtimeInput: { activityStart: {} } });
    c.send({ realtimeInput: { audio: { data: Buffer.from(new Uint8Array(3200)).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
    c.send({ realtimeInput: { activityEnd: {} } });
    await c.until(() => c.got.some((g) => g.json.serverContent?.turnComplete));
    const sc = c.got.map((g) => g.json.serverContent).filter(Boolean);
    assert.equal(sc.find((x) => x.inputTranscription)?.inputTranscription.text, 'Is Nepenthe open now?');
    assert.equal(sc.filter((x) => x.outputTranscription).map((x) => x.outputTranscription.text).join(''), "I'm checking.");
    const audio = sc.flatMap((x) => x.modelTurn?.parts ?? []).map((/** @type {any} */ p) => p.inlineData);
    assert.ok(audio.every((a) => a.mimeType === 'audio/pcm;rate=24000'));
    assert.deepEqual(new Uint8Array(Buffer.concat(audio.map((a) => Buffer.from(a.data, 'base64')))), AUDIO);
    const done = c.got.find((g) => g.json.serverContent?.turnComplete)?.json;
    assert.equal(done.usageMetadata.promptTokenCount, 600, 'usage comes with turnComplete, as the real one sends it');
    assert.ok(c.got.some((g) => g.json.sessionResumptionUpdate?.newHandle === 'h-1' && g.json.sessionResumptionUpdate.resumable));
    // A typed turn that talks on, cut off by an activityStart.
    c.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'Tell me about Bixby Bridge.' }] }], turnComplete: true } });
    await c.until(() => c.got.some((g) => g.json.serverContent?.outputTranscription?.text.startsWith('Bixby')));
    c.send({ realtimeInput: { activityStart: {} } });
    await c.until(() => c.got.some((g) => g.json.serverContent?.interrupted));
    await c.until(() => c.got.filter((g) => g.json.serverContent?.turnComplete).length === 2);
    const after = c.got.slice(c.got.findIndex((g) => g.json.serverContent?.interrupted));
    assert.ok(after[1].json.serverContent.turnComplete, 'the cut turn ends at once after interrupted, as Gemini sends it');
    // What it got, in order.
    const kinds = s.received().map((m) => Object.keys(m)[0] + (m.realtimeInput ? `.${Object.keys(m.realtimeInput)[0]}` : ''));
    assert.deepEqual(kinds, ['setup', 'realtimeInput.activityStart', 'realtimeInput.audio', 'realtimeInput.activityEnd', 'clientContent', 'realtimeInput.activityStart']);
    assert.deepEqual(s.received()[0].setup.proactivity, { proactiveAudio: true });
    assert.equal(s.connections()[0].version, 'v1alpha');
    c.ws.close();
  } finally {
    await s.stop();
  }
});

test('the stand-in refuses as Gemini does: a wrong key 1007, an unknown model 1008, proactivity on v1beta 1007', async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, models: ['gemini-3.8-live'], turns: [] });
  try {
    const wrong = client(`${s.ws}${GEMINI_PATH('v1alpha')}?key=nope`);
    await wrong.opened;
    wrong.send(setup());
    await wrong.until(() => wrong.closed !== null);
    assert.deepEqual(wrong.closed, { code: 1007, reason: 'API key not valid. Please pass a valid API key.' });
    const unknown = client(`${s.ws}${GEMINI_PATH('v1alpha')}?key=${KEY}`);
    await unknown.opened;
    unknown.send({ setup: { model: 'models/gemini-nope' } });
    await unknown.until(() => unknown.closed !== null);
    assert.equal(unknown.closed?.code, 1008);
    assert.match(String(unknown.closed?.reason), /^models\/gemini-nope is not found for API version v1alpha/);
    const beta = client(`${s.ws}${GEMINI_PATH('v1beta')}?key=${KEY}`);
    await beta.opened;
    beta.send(setup({ proactivity: { proactiveAudio: true } }));
    await beta.until(() => beta.closed !== null);
    assert.equal(beta.closed?.code, 1007);
    assert.match(String(beta.closed?.reason), /Unknown name "proactivity"/);
    const fine = client(`${s.ws}${GEMINI_PATH('v1beta')}?key=${KEY}`);
    await fine.opened;
    fine.send(setup());
    await fine.until(() => fine.got.some((g) => g.json.setupComplete));
    fine.ws.close();
  } finally {
    await s.stop();
  }
});

test('a tool call, goAway, and a close the test asks for; tool answers are recorded', async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, pace: 0, turns: [{ said: 'Checking.', tool: { name: 'tell_kokoro', args: { text: 'Is Nepenthe open?' } }, goAway: 9 }] });
  try {
    const c = client(`${s.ws}${GEMINI_PATH('v1alpha')}?key=${KEY}`);
    await c.opened;
    c.send(setup());
    await c.until(() => c.got.some((g) => g.json.setupComplete));
    c.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'Is Nepenthe open?' }] }], turnComplete: true } });
    await c.until(() => c.got.some((g) => g.json.toolCall));
    const call = c.got.find((g) => g.json.toolCall)?.json.toolCall.functionCalls[0];
    assert.equal(call.name, 'tell_kokoro');
    assert.deepEqual(call.args, { text: 'Is Nepenthe open?' });
    assert.ok(call.id);
    c.send({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response: { result: 'sent' }, scheduling: 'SILENT' }] } });
    await c.until(() => c.got.some((g) => g.json.goAway));
    assert.equal(c.got.find((g) => g.json.goAway)?.json.goAway.timeLeft, '9s');
    await c.until(() => s.received().some((m) => m.toolResponse));
    assert.equal(s.received().find((m) => m.toolResponse).toolResponse.functionResponses[0].scheduling, 'SILENT');
    s.close(1011, 'Internal error occurred.');
    await c.until(() => c.closed !== null);
    assert.deepEqual(c.closed, { code: 1011, reason: 'Internal error occurred.' });
  } finally {
    await s.stop();
  }
});

test('closeWith ends every session at its setup with that code and reason', async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', closeWith: { code: 1011, reason: 'RESOURCE_EXHAUSTED: quota' }, turns: [] });
  try {
    const c = client(`${s.ws}${GEMINI_PATH('v1alpha')}?key=any`);
    await c.opened;
    c.send(setup());
    await c.until(() => c.closed !== null);
    assert.deepEqual(c.closed, { code: 1011, reason: 'RESOURCE_EXHAUSTED: quota' });
  } finally {
    await s.stop();
  }
});

test('a message over 64 KiB is read whole', async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', turns: [] });
  try {
    const c = client(`${s.ws}${GEMINI_PATH('v1alpha')}?key=x`);
    await c.opened;
    c.send(setup());
    await c.until(() => c.got.some((g) => g.json.setupComplete));
    const big = 'x'.repeat(200_000);
    c.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: big }] }], turnComplete: false } });
    await c.until(() => s.received().length === 2);
    assert.equal(s.received()[1].clientContent.turns[0].parts[0].text.length, 200_000);
  } finally {
    await s.stop();
  }
});

// The openai flavour (K6): OpenAI Realtime as its docs describe it (developers.openai.com, read 2026-10-19).
const SK = 'sk-proj-stand-in-0123456789abcdef';
/** @param {string} path @param {string} [key] */
const openai = (path, key = SK) => [path, ['realtime', ...(key ? [`openai-insecure-api-key.${key}`] : [])]];
/** @param {any} [over] */
const update = (over = {}) => ({ type: 'session.update', session: { type: 'realtime', instructions: 'You are Koe.', output_modalities: ['audio'],
  audio: { input: { format: { type: 'audio/pcmu' }, turn_detection: null, transcription: { model: 'gpt-transcribe' } }, output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' } }, ...over } });
const OPENAI_USAGE = { total_tokens: 253, input_tokens: 132, output_tokens: 121, input_token_details: { text_tokens: 119, audio_tokens: 13, image_tokens: 0, cached_tokens: 64, cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 } },
  output_token_details: { text_tokens: 30, audio_tokens: 91 } };

test('it speaks the OpenAI Realtime flavour: session.created, session.updated, a committed turn heard and answered in a burst, response.done when generation ends; JSON in text frames', async () => {
  const s = await startRealtimeServer({
    flavour: 'openai', key: SK, models: ['gpt-realtime-2.1'], pace: 0.05,
    turns: [
      { heard: 'Is Nepenthe open now?', said: "I'm checking.", audio: AUDIO, usage: OPENAI_USAGE },
      { said: 'Bixby Bridge is a concrete arch bridge, built in 1932, and the story goes on for a long while.', audio: new Uint8Array(48_000 * 10) },
    ],
  });
  try {
    const [path, protocols] = openai('/v1/realtime?model=gpt-realtime-2.1');
    const c = client(`${s.ws}${path}`, /** @type {string[]} */ (protocols));
    await c.opened;
    assert.equal(c.ws.protocol, 'realtime', 'it answers with the realtime subprotocol, as a browser needs');
    await c.until(() => c.got.some((g) => g.json.type === 'session.created'));
    assert.ok(c.got.every((g) => !g.binary), 'OpenAI sends its JSON in text frames');
    assert.equal(c.got[0].json.session.model, 'gpt-realtime-2.1');
    assert.deepEqual(c.got[0].json.session.audio.input.turn_detection.type, 'server_vad', 'a new session detects turns by itself until told not to');
    c.send(update());
    await c.until(() => c.got.some((g) => g.json.type === 'session.updated'));
    const updated = c.got.find((g) => g.json.type === 'session.updated')?.json.session;
    assert.deepEqual([updated.audio.input.format, updated.audio.input.turn_detection, updated.audio.output.voice, updated.instructions], [{ type: 'audio/pcmu' }, null, 'marin', 'You are Koe.']);
    // A spoken turn, by hand: audio, commit, response.create.
    c.send({ type: 'input_audio_buffer.append', audio: Buffer.from(new Uint8Array(800)).toString('base64') });
    c.send({ type: 'input_audio_buffer.commit' });
    c.send({ type: 'response.create' });
    await c.until(() => c.got.some((g) => g.json.type === 'response.done'));
    const types = c.got.map((g) => g.json.type);
    const committed = c.got.find((g) => g.json.type === 'input_audio_buffer.committed')?.json;
    const heard = c.got.find((g) => g.json.type === 'conversation.item.input_audio_transcription.completed')?.json;
    assert.deepEqual([heard.item_id, heard.transcript], [committed.item_id, 'Is Nepenthe open now?']);
    assert.ok(types.indexOf('response.created') < types.indexOf('response.output_audio.delta'));
    const deltas = c.got.filter((g) => g.json.type === 'response.output_audio.delta').map((g) => g.json);
    assert.deepEqual(new Uint8Array(Buffer.concat(deltas.map((d) => Buffer.from(d.delta, 'base64')))), AUDIO);
    assert.equal(c.got.filter((g) => g.json.type === 'response.output_audio_transcript.delta').map((g) => g.json.delta).join(''), "I'm checking.");
    assert.equal(c.got.find((g) => g.json.type === 'response.output_audio_transcript.done')?.json.transcript, "I'm checking.");
    const done = c.got.find((g) => g.json.type === 'response.done')?.json.response;
    assert.deepEqual([done.status, done.usage], ['completed', OPENAI_USAGE]);
    assert.equal(done.output[0].id, deltas[0].item_id);
    // A typed turn that talks on, cancelled and truncated where it was heard; the cancelled response still reports.
    c.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tell me about Bixby Bridge.' }] } });
    c.send({ type: 'response.create' });
    c.send({ type: 'response.create' });
    await c.until(() => c.got.some((g) => g.json.type === 'error'));
    assert.equal(c.got.find((g) => g.json.type === 'error')?.json.error.code, 'conversation_already_has_active_response');
    await c.until(() => c.got.filter((g) => g.json.type === 'response.created').length === 2);
    const item = c.got.filter((g) => g.json.type === 'response.output_audio.delta').at(-1)?.json.item_id;
    c.send({ type: 'response.cancel' });
    c.send({ type: 'conversation.item.truncate', item_id: item, content_index: 0, audio_end_ms: 1500 });
    c.send({ type: 'conversation.item.truncate', item_id: item, content_index: 0, audio_end_ms: 12_000 });
    c.send({ type: 'response.cancel' });
    c.send({ type: 'input_audio_buffer.commit' });
    await c.until(() => c.got.filter((g) => g.json.type === 'error').length === 4);
    const cancelled = c.got.filter((g) => g.json.type === 'response.done').at(-1)?.json.response;
    assert.deepEqual([cancelled.status, cancelled.status_details.reason], ['cancelled', 'client_cancelled']);
    assert.deepEqual(c.got.find((g) => g.json.type === 'conversation.item.truncated')?.json, { type: 'conversation.item.truncated', event_id: c.got.find((g) => g.json.type === 'conversation.item.truncated')?.json.event_id, item_id: item, content_index: 0, audio_end_ms: 1500 });
    assert.deepEqual(c.got.filter((g) => g.json.type === 'error').slice(1).map((g) => g.json.error.code), ['invalid_value', 'response_cancel_not_active', 'input_audio_buffer_commit_empty']);
    // What it got, in order, and from whom.
    assert.deepEqual(s.received().map((m) => m.type).slice(0, 4), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
    const [conn] = s.connections();
    assert.deepEqual([conn.path, conn.model, conn.key, conn.protocols], ['/v1/realtime', 'gpt-realtime-2.1', SK, ['realtime', `openai-insecure-api-key.${SK}`]]);
    c.ws.close();
  } finally {
    await s.stop();
  }
});

test('the OpenAI stand-in refuses as OpenAI was seen to: a wrong or missing key and an unknown model with an error, then 3000 invalid_request_error; a bad field with an error alone', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', key: SK, models: ['gpt-realtime-2.1'], turns: [] });
  try {
    for (const [key, code] of [['sk-wrong', 'invalid_api_key'], ['', 'missing_api_key']]) {
      const [path, protocols] = openai('/v1/realtime?model=gpt-realtime-2.1', key);
      const c = client(`${s.ws}${path}`, /** @type {string[]} */ (protocols));
      await c.opened;
      await c.until(() => c.closed !== null);
      assert.deepEqual(c.closed, { code: 3000, reason: 'invalid_request_error' });
      const err = c.got.find((g) => g.json.type === 'error')?.json.error;
      assert.deepEqual([err.type, err.code], ['invalid_request_error', code]);
      if (key) assert.ok(err.message.includes(key), 'it says the key back, as a careless server might: annai must blank it');
    }
    const [path, protocols] = openai('/v1/realtime?model=gpt-nope');
    const unknown = client(`${s.ws}${path}`, /** @type {string[]} */ (protocols));
    await unknown.opened;
    await unknown.until(() => unknown.closed !== null);
    assert.equal(unknown.got.find((g) => g.json.type === 'error')?.json.error.code, 'model_not_found');
    const [p2, pr2] = openai('/v1/realtime?model=gpt-realtime-2.1');
    const bad = client(`${s.ws}${p2}`, /** @type {string[]} */ (pr2));
    await bad.opened;
    bad.send(update({ audio: { output: { voice: 'nobody' } } }));
    await bad.until(() => bad.got.some((g) => g.json.type === 'error'));
    assert.deepEqual(bad.got.find((g) => g.json.type === 'error')?.json.error.param, 'session.audio.output.voice');
    assert.equal(bad.closed, null, 'the session stays open after a bad field');
    bad.send(update({ audio: { input: { format: { type: 'audio/pcm', rate: 16000 } } } }));
    await bad.until(() => bad.got.filter((g) => g.json.type === 'error').length === 2);
    assert.equal(bad.got.filter((g) => g.json.type === 'error')[1].json.error.param, 'session.audio.input.format.rate');
    bad.ws.close();
  } finally {
    await s.stop();
  }
});

test('the OpenAI stand-in: a tool call as function_call_arguments.done and in response.done; its output is recorded and starts no response by itself; closeWith at the update', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', pace: 0, turns: [{ said: 'Checking.', tool: { name: 'tell_kokoro', args: { text: 'Is Nepenthe open?' } } }] });
  try {
    const [path, protocols] = openai('/v1/realtime?model=gpt-realtime-2.1');
    const c = client(`${s.ws}${path}`, /** @type {string[]} */ (protocols));
    await c.opened;
    c.send(update());
    c.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Is Nepenthe open?' }] } });
    c.send({ type: 'response.create' });
    await c.until(() => c.got.some((g) => g.json.type === 'response.done'));
    const args = c.got.find((g) => g.json.type === 'response.function_call_arguments.done')?.json;
    assert.deepEqual([args.name, JSON.parse(args.arguments)], ['tell_kokoro', { text: 'Is Nepenthe open?' }]);
    const fc = c.got.find((g) => g.json.type === 'response.done')?.json.response.output.find((/** @type {any} */ o) => o.type === 'function_call');
    assert.deepEqual([fc.call_id, fc.name, fc.arguments], [args.call_id, 'tell_kokoro', args.arguments]);
    c.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: args.call_id, output: 'sent' } });
    await c.until(() => c.got.filter((g) => g.json.type === 'conversation.item.added').length === 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.got.filter((g) => g.json.type === 'response.created').length, 1, 'an answer alone starts no response');
    assert.deepEqual(s.received().at(-1).item, { type: 'function_call_output', call_id: args.call_id, output: 'sent' });
    c.ws.close();
  } finally {
    await s.stop();
  }
  const shut = await startRealtimeServer({ flavour: 'openai', closeWith: { code: 1011, reason: 'server_error' }, turns: [] });
  try {
    const [path, protocols] = openai('/v1/realtime?model=gpt-realtime-2.1');
    const c = client(`${shut.ws}${path}`, /** @type {string[]} */ (protocols));
    await c.opened;
    c.send(update());
    await c.until(() => c.closed !== null);
    assert.deepEqual(c.closed, { code: 1011, reason: 'server_error' });
  } finally {
    await shut.stop();
  }
});
