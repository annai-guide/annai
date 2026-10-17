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
