import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesOf } from '../../scripts/realtime/frames.mjs';
import { startKokoro } from '../../scripts/realtime/kokoro.mjs';
import { parseArgs } from '../../scripts/realtime/args.mjs';

const j = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o));

test('what annai sends: the setup (without its instructions), the activity edges, audio by size, a text turn, a tool answer', () => {
  assert.deepEqual(framesOf('out', j({ setup: { model: 'm', systemInstruction: { parts: [{ text: 'SECRET INSTRUCTIONS' }] } } }), 5), [{ at: 5, dir: 'out', kind: 'setup' }]);
  assert.deepEqual(framesOf('out', j({ realtimeInput: { activityStart: {} } }), 6).map((f) => f.kind), ['activityStart']);
  assert.deepEqual(framesOf('out', j({ realtimeInput: { activityEnd: {} } }), 6).map((f) => f.kind), ['activityEnd']);
  const audio = framesOf('out', j({ realtimeInput: { audio: { data: Buffer.alloc(3200).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }), 7);
  assert.deepEqual(audio, [{ at: 7, dir: 'out', kind: 'audio', bytes: 3200 }]);
  assert.deepEqual(framesOf('out', j({ clientContent: { turns: [{ role: 'user', parts: [{ text: '<from_kokoro id="x">hi</from_kokoro>' }] }] } }), 8), [{ at: 8, dir: 'out', kind: 'text', text: '<from_kokoro id="x">hi</from_kokoro>' }]);
  assert.deepEqual(framesOf('out', j({ toolResponse: { functionResponses: [{ id: '1', name: 'tell_kokoro', response: { result: 'sent' } }] } }), 9), [{ at: 9, dir: 'out', kind: 'toolResponse', name: 'tell_kokoro' }]);
});

test('what Gemini sends: audio by size (never the audio), both transcripts, interrupted, turnComplete, tool calls, usage', () => {
  const kinds = (/** @type {any} */ m) => framesOf('in', j(m), 1).map((f) => f.kind);
  assert.deepEqual(kinds({ setupComplete: {} }), ['setupComplete']);
  const audio = framesOf('in', j({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(900).toString('base64') } }] } } }), 2);
  assert.deepEqual(audio, [{ at: 2, dir: 'in', kind: 'audio', bytes: 900 }]);
  assert.deepEqual(framesOf('in', j({ serverContent: { inputTranscription: { text: 'Hi' }, outputTranscription: { text: 'Hello' } } }), 3).map((f) => [f.kind, f.text]), [['heard', 'Hi'], ['said', 'Hello']]);
  assert.deepEqual(kinds({ serverContent: { interrupted: true } }), ['interrupted']);
  assert.deepEqual(kinds({ serverContent: { turnComplete: true }, usageMetadata: {} }), ['turnComplete', 'usage']);
  assert.deepEqual(framesOf('in', j({ toolCall: { functionCalls: [{ id: '1', name: 'tell_kokoro', args: {} }] } }), 4).map((f) => [f.kind, f.name]), [['toolCall', 'tell_kokoro']]);
  assert.deepEqual(kinds({ goAway: { timeLeft: '1s' } }), ['goAway']);
});

test('a frame that is not JSON is skipped, not a crash', () => {
  assert.deepEqual(framesOf('in', Buffer.from('not json'), 1), []);
  assert.deepEqual(framesOf('out', 'also not', 1), []);
});

test('the stand-in Kokoro refuses an empty request as a real server does, gives one note to Koe for a question, and sleeps otherwise', async () => {
  const k = await startKokoro({ delayMs: 0 });
  try {
    const post = (/** @type {any} */ body, path = '/kokoro/v1/messages') => fetch(`${k.origin}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ model: 'm', messages: [] }, '/other')).status, 404);
    const asked = await (await post({ model: 'm', messages: [{ role: 'user', content: 'Koe notes: "where is lunch"' }] })).text();
    assert.match(asked, /"name":"tell_koe"/);
    assert.match(asked, /"name":"sleep"/);
    const quiet = await (await post({ model: 'm', messages: [{ role: 'user', content: '[Koe said] it is far' }] })).text();
    assert.doesNotMatch(quiet, /tell_koe/);
    assert.equal(k.wakes(), 2);
    assert.equal((await fetch(`${k.origin}/kokoro/v1/messages`, { method: 'OPTIONS' })).status, 204);
  } finally {
    await k.stop();
  }
});

test('parseArgs: words, --name value, and flags that take no value; a missing value is an error', () => {
  assert.deepEqual(parseArgs(['run', '--only', 'a,b', '--force', '--lines', '1-11'], { flags: ['force'] }), { words: ['run'], opts: { only: 'a,b', force: true, lines: '1-11' } });
  assert.throws(() => parseArgs(['run', '--only']), /needs a value/);
});

test('the setup frame says which language hints it carried and whether its instructions name the languages, never the instructions themselves (phase 2)', () => {
  const setup = (/** @type {any} */ over) => framesOf('out', j({ setup: { model: 'm', systemInstruction: { parts: [{ text: 'You are Koe.\n\n# Languages\nThe user speaks English and Japanese; SECRET' }] }, ...over } }), 5);
  assert.deepEqual(setup({ inputAudioTranscription: { languageCodes: ['en', 'zh-Hans', 'ja'] } }), [{ at: 5, dir: 'out', kind: 'setup', text: 'languageCodes en,zh-Hans,ja; the instructions have a Languages section' }]);
  assert.deepEqual(setup({ inputAudioTranscription: {} }), [{ at: 5, dir: 'out', kind: 'setup', text: 'no languageCodes; the instructions have a Languages section' }]);
  const plain = framesOf('out', j({ setup: { model: 'm', systemInstruction: { parts: [{ text: 'You are Koe.' }] }, inputAudioTranscription: {} } }), 5);
  assert.deepEqual(plain, [{ at: 5, dir: 'out', kind: 'setup', text: 'no languageCodes; the instructions have no Languages section' }]);
  assert.ok(!JSON.stringify(setup({})).includes('SECRET'));
});
