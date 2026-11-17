import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcript } from '../../src/core/agent/transcript.js';
import { renderForSummary } from '../../src/core/agent/compaction.js';
import { record } from '../../src/core/agent/log.js';
import { traceSummary, traceStored } from '../../src/ui/screens/trace.js';
import { whyWords } from '../../src/core/llm/fallback.js';
import { tidyFailed } from '../../src/core/agent/loop.js';
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

// A live line is logged with its first words and all of them after Koe's turn (koe/live.js): recall gives the later ones, as every reader of
// the conversation's lines does (conversationLines), and finds the line by them.
test('recall gives a live line its words written down later, not its first ones', async () => {
  const k = await agentKit([[{ text: '' }]]);
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'heard', text: '' }] } });
  await record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id: 's-1', wake: 'w-1', ms: 1200, source: 'live', text: 'Is it' } });
  await record(k.store, k.trip, { type: 'heard.text', actor: 'system', data: { of: 's-1', text: 'Is it far?', by: 'Live' } });
  const recall = /** @type {any} */ (k.agent.loopTools().find((t) => t.name === 'recall'));
  assert.match(await recall.run({ query: 'far' }, {}), /#\d+ user said: Is it far\?$/m);
});

test('the trace says what was heard, and what it turned out to say', () => {
  assert.equal(traceSummary({ type: 'heard', data: { id: 's-1', ms: 1500, source: 'mic', answer: 'c1', clip: 'h' } }), '1.5 sec from the microphone · an answer · clip kept');
  assert.equal(traceSummary({ type: 'heard', data: { id: 's-2', ms: 0, source: 'dictation', text: 'hi', meanwhile: true, dismissed: true } }), 'phone dictation · "hi" · while she was thinking · not for Shiori');
  assert.equal(traceSummary({ type: 'heard.text', data: { of: 's-1', text: 'where should we eat', by: 'GPT Transcribe' } }), '"where should we eat" · written down by GPT Transcribe');
  // Each clip's format and size (Koe and Kokoro design, "Audio formats"): kept, sent to be written down, sent to a model, and a voice's.
  assert.equal(traceSummary({ type: 'heard', data: { id: 's-3', ms: 1700, source: 'mic', clip: 'h', clipFormat: 'ogg', clipBytes: 5283 } }), '1.7 sec from the microphone · clip kept: ogg, 5.2 kB');
  assert.equal(traceSummary({ type: 'net.request', data: { kind: 'speech-in', model: 'Groq: Whisper', outcome: 'ok', status: 200, ms: 410, format: 'webm', bytes: 5745 } }), 'Groq: Whisper · ok (200) · 410 ms · webm, 5.6 kB');
  assert.equal(traceSummary({ type: 'net.request', data: { kind: 'speech-out', model: 'GPT-4o mini TTS', outcome: 'ok', status: 200, ms: 800, format: 'ogg', bytes: 30_000 } }), 'GPT-4o mini TTS · ok (200) · 800 ms · ogg, 29 kB');
  assert.equal(traceSummary({ type: 'net.request', data: { kind: 'model', model: 'Gemini 3.8 Flash', outcome: 'ok', status: 200, ms: 2100, audio: [{ format: 'wav', bytes: 53_392 }] } }), 'Gemini 3.8 Flash · ok (200) · 2100 ms · audio: wav, 52 kB');
});

test("the Trace's Errors rows are made again from the why an entry kept, each model by its provider's name first, in annai's English; an entry with no why keeps its stored words (the final review's finding src1-B)", () => {
  const names = (/** @type {string} */ n) => ({ 'Claude Opus 5.5': 'Anthropic / Claude Opus 5.5' })[n] ?? n;
  const why = { attempts: [{ model: 'm-0', name: 'Claude Opus 5.5', outcome: 'credit', ms: 1 }] };
  const stored = whyWords(why, true); // what the log kept: the model's name alone
  const model = { type: 'error', data: { kind: 'model', why, message: stored } };
  assert.equal(traceSummary(model, { names }), `model: ${whyWords(why, true, { names })}`);
  assert.match(traceSummary(model, { names }), /^model: Anthropic \/ Claude Opus 5\.5: /);
  assert.match(traceSummary({ type: 'error', data: { kind: 'compaction', why, message: tidyFailed(why, true) } }, { names }), /^compaction: Anthropic \/ Claude Opus 5\.5: .* Until it is tidied up/);
  // The words the line marks as English are the ones it shows.
  for (const kept of traceStored(model, { names })) assert.ok(traceSummary(model, { names }).includes(kept), kept);
  // An older entry has no why: its stored words, as before; so has one that is not about a model.
  assert.equal(traceSummary({ type: 'error', data: { kind: 'model', message: 'Claude Opus 5.5: Out of credit.' } }, { names }), 'model: Claude Opus 5.5: Out of credit.');
  assert.equal(traceSummary({ type: 'error', data: { kind: 'budget', message: 'Steps used up.' } }, { names }), 'budget: Steps used up.');
  assert.equal(traceSummary(model), `model: ${stored}`, 'with no names it reads as it was stored');
});

test("the Trace names a model by its provider's name first: the one its request kept, else the one that has the name now (the user, 2026-11-16)", () => {
  const names = (/** @type {string} */ n) => ({ 'Claude Opus 5.5': 'Anthropic / Claude Opus 5.5', 'GPT Transcribe': 'OpenAI / GPT Transcribe' })[n] ?? n;
  // A request kept its provider's name as it was then (call.js), so a provider renamed since doesn't rename it.
  assert.equal(traceSummary({ type: 'net.request', data: { kind: 'model', endpoint: 'OpenRouter', model: 'Anthropic: Claude Opus 5.5', outcome: 'ok', status: 200, ms: 900 } }, { names }),
    'OpenRouter / Anthropic: Claude Opus 5.5 · ok (200) · 900 ms');
  assert.equal(traceSummary({ type: 'live.session', data: { state: 'open', endpoint: 'Gemini', model: 'Gemini 3.8 Live' } }, { names }), 'live session open · Gemini / Gemini 3.8 Live');
  // A turn and a transcript kept only the model's name.
  assert.equal(traceSummary({ type: 'model.turn', data: { role: 'main', answeredBy: 'Claude Opus 5.5', attempts: [{}] } }, { names }), 'main: Anthropic / Claude Opus 5.5 · 1 attempt');
  assert.equal(traceSummary({ type: 'model.turn', data: { role: 'main', answeredBy: null, attempts: [] } }, { names }), 'main: no answer · 0 attempts');
  assert.equal(traceSummary({ type: 'heard.text', data: { of: 's-1', text: 'hi', by: 'GPT Transcribe' } }, { names }), '"hi" · written down by OpenAI / GPT Transcribe');
  assert.equal(traceSummary({ type: 'heard.text', data: { of: 's-1', text: 'hi', by: 'Phone dictation' } }, { names }), '"hi" · written down by Phone dictation');
});
