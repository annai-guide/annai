import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toInput, toContent, toolSchema, STAND_IN_SIGNATURE } from '../../plugins-official/gemini-api/steps.js';

const MODEL = 'gemini-3.5-flash-lite';
/** @param {string} text */
const say = (text) => ({ type: 'text', text });

test('a user message becomes one user_input step, text, image, audio and document parts in order', () => {
  const steps = toInput([{ role: 'user', parts: [
    say('Look at these.'),
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'image', mediaType: 'image/webp', data: 'BBBB', fileId: 'https://generativelanguage.googleapis.com/v1beta/files/abc' },
    { type: 'image', mediaType: 'image/jpeg', data: '', missing: true },
    { type: 'audio', mediaType: 'audio/ogg', data: 'T2dn' },
    { type: 'document', mediaType: 'application/pdf', data: 'JVBE', name: 'menu.pdf' },
  ] }], { model: MODEL });
  assert.deepEqual(steps, [{ type: 'user_input', content: [
    { type: 'text', text: 'Look at these.' },
    { type: 'image', data: 'AAAA', mime_type: 'image/png' },
    { type: 'image', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mime_type: 'image/webp' },
    { type: 'audio', data: 'T2dn', mime_type: 'audio/ogg' },
    { type: 'document', data: 'JVBE', mime_type: 'application/pdf' },
  ] }]);
});

test("audio goes by the names Gemini's API takes: the phone's AAC in MP4 is audio/m4a", () => {
  assert.deepEqual(toContent({ type: 'audio', mediaType: 'audio/mp4', data: 'AAAA' }), { type: 'audio', data: 'AAAA', mime_type: 'audio/m4a' });
  for (const t of ['audio/webm', 'audio/aac', 'audio/mpeg', 'audio/flac', 'audio/wav']) assert.equal(toContent({ type: 'audio', mediaType: t, data: 'x' })?.mime_type, t);
  assert.equal(toContent({ type: 'speech', id: 's1', text: 'hi' }), null);
});

test('the tail goes last in the final user_input', () => {
  const steps = toInput([{ role: 'user', parts: [say('Hello.')] }], { model: MODEL, tail: 'Now: Kyoto, 09:00.' });
  assert.deepEqual(steps, [{ type: 'user_input', content: [say('Hello.'), say('Now: Kyoto, 09:00.')] }]);
  // After tool results there is no user_input to end with: the now block is one of its own.
  const after = toInput([
    { role: 'user', parts: [say('Weather?')] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'get_weather', input: { city: 'Kyoto' }, extra: { signature: 'CALLSIG' }, model: MODEL }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: '18°C' }] },
  ], { model: MODEL, tail: 'Now: Kyoto, 09:00.' });
  assert.deepEqual(after.at(-1), { type: 'user_input', content: [say('Now: Kyoto, 09:00.')] });
  assert.equal(after.at(-2)?.type, 'function_result');
});

test("an assistant message's parts become steps in their order", () => {
  const steps = toInput([
    { role: 'user', parts: [say('Weather in Kyoto?')] },
    { role: 'assistant', parts: [
      { type: 'reasoning', text: 'Use the tool.', signature: 'THOUGHTSIG', model: MODEL },
      { type: 'reasoning', text: '', signature: 'QUIETSIG', model: MODEL },
      say('Let me'),
      say(' check.'),
      { type: 'tool_call', id: 'call_41070', name: 'get_weather', input: { city: 'Kyoto' }, extra: { signature: 'CALLSIG' }, model: MODEL },
      { type: 'provider', block: { type: 'google_search_call', id: 's1', arguments: { queries: ['kyoto'] }, signature: 'SEARCHSIG' }, model: MODEL },
    ] },
  ], { model: MODEL });
  assert.deepEqual(steps.slice(1), [
    { type: 'thought', signature: 'THOUGHTSIG', summary: [{ type: 'text', text: 'Use the tool.' }] },
    { type: 'thought', signature: 'QUIETSIG' },
    { type: 'model_output', content: [{ type: 'text', text: 'Let me check.' }] },
    { type: 'function_call', id: 'call_41070', name: 'get_weather', arguments: { city: 'Kyoto' }, signature: 'CALLSIG' },
    { type: 'google_search_call', id: 's1', arguments: { queries: ['kyoto'] }, signature: 'SEARCHSIG' },
  ]);
});

test("another model's signed reasoning and tool_call extra are not sent; reasoning nobody signed isn't either", () => {
  const steps = toInput([
    { role: 'user', parts: [say('Weather?')] },
    { role: 'assistant', parts: [
      { type: 'reasoning', text: 'Theirs.', signature: 'OTHERSIG', model: 'other' },
      { type: 'reasoning', text: 'Unsigned.' },
      { type: 'tool_call', id: 'c1', name: 'get_weather', input: { city: 'Kyoto' }, extra: { signature: 'OTHERCALL' }, model: 'other' },
      { type: 'provider', block: { type: 'google_search_call' }, model: 'other' },
    ] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: '18°C' }] },
    { role: 'assistant', parts: [say('It is 18°C.')] },
    { role: 'user', parts: [say('Thanks.')] },
  ], { model: MODEL });
  assert.deepEqual(steps[1], { type: 'function_call', id: 'c1', name: 'get_weather', arguments: { city: 'Kyoto' } });
  assert.ok(!JSON.stringify(steps).includes('OTHER'), 'nothing another model signed');
  assert.ok(!steps.some((s) => s.type === 'thought'));
});

test("a call in the current turn another model wrote carries Google's stand-in signature, so a fallback mid-turn isn't refused; earlier turns' calls, and Gemini's own, are as they were", () => {
  const messages = [
    { role: 'user', parts: [say('Weather in Kyoto?')] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'old', name: 'get_weather', input: { city: 'Kyoto' } }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'old', content: '18°C' }] },
    { role: 'assistant', parts: [say('18°C.')] },
    { role: 'user', parts: [say('And Nara?')] },
    { role: 'assistant', parts: [
      { type: 'tool_call', id: 'mine', name: 'get_weather', input: { city: 'Nara' }, extra: { signature: 'CALLSIG' }, model: MODEL },
      { type: 'tool_call', id: 'mine2', name: 'get_weather', input: { city: 'Uji' }, model: MODEL },
    ] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'mine', content: '17°C' }, { type: 'tool_result', id: 'mine2', content: '16°C' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'theirs', name: 'get_weather', input: { city: 'Osaka' } }, { type: 'tool_call', id: 'theirs2', name: 'get_weather', input: 'cut short' }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'theirs', content: '19°C' }] },
  ];
  const calls = Object.fromEntries(toInput(messages, { model: MODEL }).filter((s) => s.type === 'function_call').map((s) => [s.id, s]));
  assert.equal(STAND_IN_SIGNATURE, 'skip_thought_signature_validator', "Google's documented value, accepted on 2026-10-19 where an unsigned call was refused");
  assert.equal(calls.old.signature, undefined, 'an earlier turn: Gemini accepted it unsigned');
  assert.deepEqual([calls.mine.signature, calls.mine2.signature], ['CALLSIG', undefined], 'its own reply: as it wrote it');
  assert.deepEqual([calls.theirs.signature, calls.theirs2.signature], [STAND_IN_SIGNATURE, STAND_IN_SIGNATURE]);
  assert.deepEqual(calls.theirs2.arguments, {}, 'arguments cut short go as an empty object');
});

test('tool results become function_result steps named after their call, ahead of the rest of the message', () => {
  const steps = toInput([
    { role: 'user', parts: [say('Weather?')] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'get_weather', input: {} }, { type: 'tool_call', id: 'c2', name: 'show_on_map', input: {} }] },
    { role: 'user', parts: [say('Also this.'), { type: 'tool_result', id: 'c1', content: '18°C' }, { type: 'tool_result', id: 'c2', content: 'No such place.', isError: true }] },
  ], { model: MODEL });
  assert.deepEqual(steps.slice(3), [
    { type: 'function_result', call_id: 'c1', name: 'get_weather', result: [{ type: 'text', text: '18°C' }] },
    { type: 'function_result', call_id: 'c2', name: 'show_on_map', result: [{ type: 'text', text: 'No such place.' }], is_error: true },
    { type: 'user_input', content: [say('Also this.')] },
  ]);
});

test("a tool result whose call isn't in the messages uses the name 'tool' (a trimmed conversation)", () => {
  const steps = toInput([{ role: 'user', parts: [{ type: 'tool_result', id: 'gone', content: 'ok' }] }], { model: MODEL });
  assert.deepEqual(steps, [{ type: 'function_result', call_id: 'gone', name: 'tool', result: [{ type: 'text', text: 'ok' }] }]);
});

test("a tool's definition is a function tool with its schema as parameters", () => {
  assert.deepEqual(toolSchema({ name: 'get_weather', description: 'Weather.', input: { type: 'object', properties: { city: { type: 'string' } } } }),
    { type: 'function', name: 'get_weather', description: 'Weather.', parameters: { type: 'object', properties: { city: { type: 'string' } } } });
});
