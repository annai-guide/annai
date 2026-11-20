import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readConfig, modelOf, removeModel, newModel, saveModel } from '../../src/core/llm/config.js';
import { createLlm } from '../../src/core/llm/service.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { REQUEST_MS } from '../../src/core/llm/uploads.js';
import { speechProblem } from '../../src/ui/speech-check.js';
import { hostKit } from './package-kit.js';
import { useClock } from './clock.js';

// A voice added by id on OpenRouter's Voice section (voice-id-next): it starts with the voice OpenRouter's list gives that id, as one
// added from Fetch model list does, and a sample its server refuses says the server's own reason. The stand-in answers as OpenRouter
// did: the main session's probe of 2026-11-20 (its test key, "Hello there." with no voice) got a 400 from every maker but Fish Audio,
// with the words below; the streamed-voice build's real run (2026-11-19) got "Voice not found" for HeyGen's voice sent Fish Audio's.
// The bodies are shaped as the voice probe recorded OpenRouter's 400s (test/fixtures/voices/openrouter-pcm-probe.json).

const root = new URL('../../', import.meta.url);
const KEY = 'sk-or-v1-stand-in-key-0123456789abcdef';
/** Women KatKat, the Fish Audio library voice OpenRouter's voice ability gives (provider-openrouter's description). */
const KATKAT = 'bddf65d5a84c4a9aa36b7136bdac57a9';
const STYLE = 'young, cheerful and lively, yet calm and gentle';
const HEYGEN_NONE = 'An explicit voice is required unless input_references carries a reference recording.';
const OTHER_NONE = 'An explicit voice is required for this TTS provider.';
const UNKNOWN = 'Voice not found';
/** @param {string} message */
const refused = (message) => new Response(JSON.stringify({ error: { message, code: 400 } }), { status: 400, headers: { 'content-type': 'application/json' } });
/**
 * OpenRouter's speech list, as /models?output_modalities=speech answers: Fish Audio's take any voice of its library (supported_voices null),
 * the others list theirs. Grok's are the description's; HeyGen's names are stand-ins (the real list's were not recorded).
 */
const SPEECH = [
  { id: 'fish-audio/s2.1-pro', name: 'Fish Audio: S2.1 Pro', supported_voices: null },
  { id: 'heygen/heygen-voice-1', name: 'HeyGen: Voice 1', supported_voices: ['Allison', 'Ivy'] },
  { id: 'x-ai/grok-voice-tts-1.0', name: 'SpaceXAI: Grok Voice TTS 1.0', supported_voices: ['eve', 'ara', 'rex', 'sal', 'leo'] },
];

/**
 * OpenRouter as the probe found it. Its list: up, offline (no connection) or hanging (never answers). Its voices: Fish Audio's speak with
 * any voice or none; any other answers a 400 with no voice, or with one its list doesn't give that id, else audio: raw PCM where it was
 * asked for it (HeyGen's sends nothing else), else MP3. Anything else is annai's own files, for its catalog and plugins.
 * @param {{ list?: 'up' | 'offline' | 'hangs' }} [o]
 */
function openRouter({ list = 'up' } = {}) {
  /** @type {any[]} */
  const said = [];
  /** @type {string[]} */
  const lists = [];
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = new URL(String(url), 'http://annai.test');
    if (u.origin !== 'https://openrouter.ai') {
      try {
        return new Response(await readFile(new URL(`.${u.pathname}`, root)));
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    if (init.headers?.authorization !== `Bearer ${KEY}`) return Response.json({ error: { code: 401, message: 'No cookie auth credentials found' } }, { status: 401 });
    if (u.pathname === '/api/v1/models') lists.push(u.searchParams.get('output_modalities') ?? 'text');
    if (u.pathname === '/api/v1/models' && u.searchParams.get('output_modalities') === 'speech') {
      if (list === 'offline') throw new TypeError('Failed to fetch');
      if (list === 'hangs') return new Promise(() => {});
      return Response.json({ data: SPEECH });
    }
    if (u.pathname !== '/api/v1/audio/speech') return new Response('not found', { status: 404 });
    const body = JSON.parse(String(init.body));
    said.push(body);
    if (!/^fish-audio\//.test(body.model)) {
      if (!body.voice) return refused(/^heygen\//.test(body.model) ? HEYGEN_NONE : OTHER_NONE);
      if (!(SPEECH.find((m) => m.id === body.model)?.supported_voices ?? []).includes(body.voice)) return refused(UNKNOWN);
    }
    return body.response_format === 'pcm' ? new Response(new Uint8Array(882), { headers: { 'content-type': 'audio/pcm;rate=44100;channels=1' } })
      : new Response(new Uint8Array([0xff, 0xf3, 1, 2]), { headers: { 'content-type': 'audio/mpeg' } });
  };
  return { fetch, said, lists };
}

/** OpenRouter added with the stand-in's key, and its models as they are now. @param {ReturnType<typeof openRouter>} or */
async function added(or) {
  const k = await hostKit();
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: k.host, fetch: or.fetch });
  const id = await llm.addProvider('provider-openrouter', { key: KEY });
  const model = async (/** @type {string} */ modelId) => modelOf((await readConfig(k.ws)).models[modelId]);
  /** The model whose provider model id this is, of the ones OpenRouter's description gave. @param {string} pid */
  const described = async (pid) => /** @type {string} */ (Object.values((await readConfig(k.ws)).models).find((m) => modelOf(m).providerId === pid)?.id);
  return { k, llm, id, model, described };
}

/** A sample that failed, and the words its card shows. @param {Promise<unknown>} p */
async function refusal(p) {
  const e = await p.then(() => null, (x) => x);
  assert.ok(e instanceof ProviderError, `refused, not ${e}`);
  return { e, words: speechProblem(e) };
}

test("HeyGen's and Grok's voices added by id start with the voice OpenRouter's list gives them (its first warm or neutral, else its first), as from Fetch model list, and speak; Fish Audio's starts with Women KatKat and the style, as before", async () => {
  const or = openRouter();
  const { llm, id, model, described, k } = await added(or);
  const heygen = await llm.addModelById(id, 'voice', 'heygen/heygen-voice-1');
  assert.equal((await model(heygen)).name, 'heygen/heygen-voice-1', 'named by its id, as any model added by id');
  assert.deepEqual((await model(heygen)).tunables, { voice: 'Allison', voices: ['Allison', 'Ivy'], styled: false }, "its voices for the Voice field, the first, and no style: HeyGen's takes none");
  const spoken = await llm.synthesize({ modelId: heygen, text: 'Hello there.' });
  assert.equal(spoken.clip?.mediaType, 'audio/wav');
  assert.deepEqual(or.said.at(-1), { model: 'heygen/heygen-voice-1', input: 'Hello there.', response_format: 'pcm', voice: 'Allison' });
  // Its description has Grok's voice already: removed first, as a model the provider has is refused, not added twice.
  await removeModel(k.ws, await described('x-ai/grok-voice-tts-1.0'));
  const grok = await llm.addModelById(id, 'voice', 'x-ai/grok-voice-tts-1.0');
  assert.deepEqual((await model(grok)).tunables, { voice: 'eve', voices: ['eve', 'ara', 'rex', 'sal', 'leo'], styled: false }, 'none of its voices is warm or neutral: its first');
  await llm.synthesize({ modelId: grok, text: 'Hello there.' });
  assert.deepEqual(or.said.at(-1), { model: 'x-ai/grok-voice-tts-1.0', input: 'Hello there.', response_format: 'mp3', voice: 'eve' });
  // The voice page's Voice field shows the list's voice as the model's own default (grey), so emptying it never falls back to Women KatKat.
  const rec = (await readConfig(k.ws)).models[heygen];
  assert.deepEqual([rec.template?.id, rec.template?.values?.tunables?.voice, rec.user], ['list/heygen/heygen-voice-1', 'Allison', {}]);
  // Fish Audio's list entry gives no voice (any of its library), so it starts with the ability's, as one added by id always did.
  const fish = await llm.addModelById(id, 'voice', 'fish-audio/s2.1-pro');
  assert.deepEqual((await model(fish)).tunables, {});
  await llm.synthesize({ modelId: fish, text: 'Hello there.' });
  assert.deepEqual(or.said.at(-1), { model: 'fish-audio/s2.1-pro', input: 'Hello there.', response_format: 'mp3', voice: KATKAT, instructions: STYLE });
  // Each voice's add read the speech list once; a chat model added by id reads none: OpenRouter's is large, and a chat model works without it.
  assert.deepEqual(or.lists, ['speech', 'speech', 'speech']);
  await llm.addModelById(id, 'chat', 'some/chat-model');
  assert.deepEqual(or.lists, ['speech', 'speech', 'speech']);
});

test("With no list to read (offline, or no answer in REQUEST_MS), or an id OpenRouter's list doesn't have, a voice is added by id as before: Women KatKat, which HeyGen's refuses, and the refused sample says HeyGen's own reason", async (t) => {
  {
    const or = openRouter({ list: 'offline' });
    const { llm, id, model } = await added(or);
    const heygen = await llm.addModelById(id, 'voice', 'heygen/heygen-voice-1');
    assert.deepEqual((await model(heygen)).tunables, {}, "the ability's voice, as before");
    const { e, words } = await refusal(llm.synthesize({ modelId: heygen, text: 'Hello there.' }));
    assert.equal(or.said.at(-1).voice, KATKAT);
    assert.equal(e.kind, 'bad-request');
    assert.equal(words, 'The provider didn\'t accept the request: "Voice not found".');
  }
  {
    const or = openRouter();
    const { llm, id, model } = await added(or);
    const unlisted = await llm.addModelById(id, 'voice', 'heygen/heygen-voice-9');
    assert.deepEqual((await model(unlisted)).tunables, {}, 'an id the list lacks: by id, as before');
    assert.match((await refusal(llm.synthesize({ modelId: unlisted, text: 'Hello there.' }))).words, /"Voice not found"\.$/);
  }
  const or = openRouter({ list: 'hangs' });
  const { llm, id, model } = await added(or);
  useClock(t);
  const from = Date.now();
  const heygen = await llm.addModelById(id, 'voice', 'heygen/heygen-voice-1');
  assert.equal(Date.now() - from, REQUEST_MS, 'the add waits for the list as long as annai waits for its other small lists, no longer');
  assert.deepEqual((await model(heygen)).tunables, {});
});

test("A voice added by id before this build (no voice of its own: the ability's Women KatKat) stays as it was: HeyGen's is refused, its sample says why, and added again it speaks", async () => {
  const or = openRouter();
  const { llm, id, model, k } = await added(or);
  // As the old Add by id stored it: the id in the user's layer, nothing else.
  const old = newModel(id, 'voice', { user: { providerId: 'heygen/heygen-voice-1' } });
  await saveModel(k.ws, old);
  assert.deepEqual((await model(old.id)).tunables, {});
  const { words } = await refusal(llm.synthesize({ modelId: old.id, text: 'Hello there.' }));
  assert.equal(or.said.at(-1).voice, KATKAT);
  assert.equal(words, 'The provider didn\'t accept the request: "Voice not found".');
  await removeModel(k.ws, old.id);
  const again = await llm.addModelById(id, 'voice', 'heygen/heygen-voice-1');
  await llm.synthesize({ modelId: again, text: 'Hello there.' });
  assert.equal(or.said.at(-1).voice, 'Allison');
});

test("A refused sample's words: the provider's reason as plain text (outside text, quoted, never read), its spaces and controls one space, its full stop the sentence's, cut at 120 characters; without one, or for any other failure, the kind's words as before", async () => {
  const fromBody = (/** @type {number} */ status, /** @type {string} */ body) => speechProblem(errorFromResponse(status, body));
  assert.equal(fromBody(400, JSON.stringify({ error: { message: OTHER_NONE, code: 400 } })), 'The provider didn\'t accept the request: "An explicit voice is required for this TTS provider".');
  assert.equal(fromBody(400, JSON.stringify({ error: { message: HEYGEN_NONE, code: 400 } })), `The provider didn't accept the request: "${HEYGEN_NONE.slice(0, -1)}".`, 'the longest the probe saw, whole');
  // HeyGen's refusal of WAV (the voice probe of 2026-11-19): a dump, its lines one, cut.
  const probe = JSON.parse(await readFile(new URL('test/fixtures/voices/openrouter-pcm-probe.json', root), 'utf8'));
  const dump = fromBody(400, probe.heygenWavRefused.body);
  const quoted = /: "(.*)"\.$/.exec(dump)?.[1] ?? '';
  assert.equal(quoted.length, 120);
  assert.ok(quoted.endsWith('…') && quoted.startsWith('[ { "code": "invalid_value", "values": [ "mp3", "pcm" ]'), quoted);
  assert.equal(fromBody(400, JSON.stringify({ error: { message: 'Bad‮\u0000 voice\n\tname.' } })), 'The provider didn\'t accept the request: "Bad voice name".', 'no control or direction mark reaches the screen');
  // No words in the answer: its kind's, as before.
  assert.equal(fromBody(400, ''), "The provider didn't accept the request. Check the tunables on its provider's page.");
  // Another kind's words stay its kind's: a rejected key, whatever the provider said.
  assert.equal(fromBody(401, JSON.stringify({ error: { message: 'No cookie auth credentials found' } })), 'The key was rejected. Check it in Settings → Models.');
  // annai's own refusal says its own words.
  assert.equal(speechProblem(new ProviderError('bad-request', "Voice A isn't a voice.", { said: { code: 'not-out', name: 'Voice A' } })), "Voice A isn't a voice.");
});
