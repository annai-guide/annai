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
 * @param {string} url
 */
function client(url) {
  const ws = new WebSocket(url);
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
    assert.equal(c.got.filter((g) => g.json.serverContent?.turnComplete).length, 1, 'the cut-off turn never completes');
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
