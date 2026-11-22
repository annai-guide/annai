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
import { SPEECH_LIST, KATKAT, PCM_TYPE, refusal, recordedType } from '../fakes/openrouter-speech.js';

// A voice added by id on OpenRouter's Voice section (voice-id-next): it starts with the voice OpenRouter's list gives that id, as one
// added from Fetch model list does, and a sample its server refuses says what to change. The stand-in is test/fakes/openrouter-speech.js,
// built from the real answers: the public speech list of 2026-11-20 (test/fixtures/voices/openrouter-speech-list.json) and the main
// session's probes of the same day with the test key (test/fixtures/voices/openrouter-voices-probe.json: each maker's answer to Women
// KatKat's id, HeyGen's free variant taking its sibling's voice, ByteDance's model taking none), and the streamed-voice build's real run
// (2026-11-19: HeyGen's "Voice not found"). What the stand-in fills in (its header lists it: the answer to an id OpenRouter doesn't have,
// Voxtral's and Kokoro's audio type, Kokoro's af_heart) was never recorded: no assertion rests on it.

const root = new URL('../../', import.meta.url);
const KEY = 'sk-or-v1-stand-in-key-0123456789abcdef';
const STYLE = 'young, cheerful and lively, yet calm and gentle';
/** What a refused voice's sample says to check, where the maker gave no words (Grok's and Voxtral's bare 404). */
const NOT_FOUND = "The provider doesn't know this model, address or voice. Check the model id, the base URL and the Voice.";

/**
 * OpenRouter as the probes found it. Its list: up, offline (no connection), refused (503) or hanging (never answers). Its voices: per
 * test/fakes/openrouter-speech.js; the audio of one it accepts is raw PCM where it was asked for it (HeyGen's sends nothing else), else MP3.
 * Anything else is annai's own files, for its catalog and plugins.
 * @param {{ list?: 'up' | 'offline' | 'refused' | 'hangs' }} [o]
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
      if (list === 'refused') return Response.json({ error: { code: 503, message: 'Service unavailable' } }, { status: 503 });
      if (list === 'hangs') return new Promise(() => {});
      return Response.json({ data: SPEECH_LIST });
    }
    if (u.pathname !== '/api/v1/audio/speech') return new Response('not found', { status: 404 });
    const body = JSON.parse(String(init.body));
    said.push(body);
    const no = refusal(body);
    if (no) return new Response(no.body, { status: no.status, headers: { 'content-type': no.type } });
    return body.response_format === 'pcm' ? new Response(new Uint8Array(882), { headers: { 'content-type': PCM_TYPE } })
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
  const described = async (pid) => Object.values((await readConfig(k.ws)).models).find((m) => modelOf(m).providerId === pid)?.id;
  /**
   * Added by id as the screen adds it; a model the description has (by the id the list gives it) is removed first, since an add is refused
   * for an id the provider has. @param {string} pid what is typed @param {string} [listed] the id the list gives it
   */
  const byId = async (pid, listed = pid) => {
    const had = await described(listed);
    if (had) await removeModel(k.ws, had);
    return llm.addModelById(id, 'voice', pid);
  };
  return { k, llm, id, model, byId };
}

/** A sample that failed, and the words its card shows. @param {Awaited<ReturnType<typeof added>>} o @param {Promise<unknown>} p */
async function refusedWith({ k }, p) {
  const e = await p.then(() => null, (x) => x);
  assert.ok(e instanceof ProviderError, `refused, not ${e}`);
  return { e, words: await speechProblem(k.store, e, true) };
}
const sample = (/** @type {Awaited<ReturnType<typeof added>>} */ o, /** @type {string} */ modelId) => o.llm.synthesize({ modelId, text: 'Hello there.' });
const voicesOf = (/** @type {string} */ id) => /** @type {string[]} */ (SPEECH_LIST.find((m) => m.id === id)?.supported_voices);

test("Online, a voice added by id starts with the voice OpenRouter's list gives that id (its first warm or neutral, else its first), its case ignored, a variant that lists none taking its base's, and speaks; Fish Audio's starts with Women KatKat and the style, as before", async () => {
  const or = openRouter();
  const o = await added(or);
  const { llm, id, model, k } = o;
  // [typed, stored provider id, voice, format asked, voices the Voice field suggests]
  /** @type {[string, string, string, string, string[]][]} */
  const cases = [
    ['heygen/heygen-voice-1', 'heygen/heygen-voice-1', 'nadine', 'pcm', voicesOf('heygen/heygen-voice-1')],
    // Its list entry lists none: its base's (the probe: nadine, 200 PCM).
    ['heygen/heygen-voice-1-turbo:free', 'heygen/heygen-voice-1-turbo:free', 'nadine', 'pcm', voicesOf('heygen/heygen-voice-1-turbo')],
    ['x-ai/grok-voice-tts-1.0', 'x-ai/grok-voice-tts-1.0', 'eve', 'mp3', voicesOf('x-ai/grok-voice-tts-1.0')],
    // The warm voice is not the first: Voxtral's neutral one is its second.
    ['mistralai/voxtral-mini-tts-2603', 'mistralai/voxtral-mini-tts-2603', 'en_paul_neutral', 'mp3', voicesOf('mistralai/voxtral-mini-tts-2603')],
    // Kokoro's af_heart is its fourth; typed in other case, it is the list's id that is stored.
    ['hexgrad/Kokoro-82M', 'hexgrad/kokoro-82m', 'af_heart', 'mp3', voicesOf('hexgrad/kokoro-82m')],
  ];
  /** @type {import('../../src/core/llm/config.js').ModelRecord | undefined} */
  let heygen;
  for (const [typed, providerId, voice, format, voices] of cases) {
    const made = await o.byId(typed, providerId);
    heygen ??= (await readConfig(k.ws)).models[made];
    const m = await model(made);
    assert.equal(m.providerId, providerId, typed);
    assert.equal(m.name, providerId, 'named by its id, as any model added by id');
    assert.deepEqual(m.tunables, { voice, voices, styled: false }, `${typed}: its voices for the Voice field, its voice, and no style: its vendor takes none`);
    const clip = (await sample(o, made)).clip;
    // The clip's type is what the maker sent: asserted where the probes recorded it (HeyGen's raw PCM, which annai makes a WAV; Grok's MP3).
    if (recordedType(providerId)) assert.equal(clip?.mediaType, format === 'pcm' ? 'audio/wav' : 'audio/mpeg', typed);
    assert.deepEqual(or.said.at(-1), { model: providerId, input: 'Hello there.', response_format: format, voice }, typed);
  }
  assert.equal(voicesOf('hexgrad/kokoro-82m').indexOf('af_heart'), 3, "Kokoro's warm voice is not its first");
  assert.equal(voicesOf('mistralai/voxtral-mini-tts-2603').indexOf('en_paul_neutral'), 1, "Voxtral's is not its first");
  assert.equal(SPEECH_LIST.find((m) => m.id === 'heygen/heygen-voice-1-turbo:free')?.supported_voices, null, 'the free variant lists none of its own');
  // The Voice field shows the list's voice as the model's own default (grey), so emptying it never falls back to Women KatKat.
  assert.deepEqual([heygen?.template?.id, heygen?.template?.values?.tunables?.voice, heygen?.user], ['list/heygen/heygen-voice-1', 'nadine', {}]);
  // Fish Audio's list entry gives no voice (any of its library), so it starts with the ability's, as one added by id always did.
  const fish = await llm.addModelById(id, 'voice', 'fish-audio/s2.1-pro');
  assert.deepEqual((await model(fish)).tunables, {});
  await sample(o, fish);
  assert.deepEqual(or.said.at(-1), { model: 'fish-audio/s2.1-pro', input: 'Hello there.', response_format: 'mp3', voice: KATKAT, instructions: STYLE });
  // Each voice's add read the speech list once; a chat model added by id reads none: OpenRouter's is large, and a chat model works without it.
  assert.deepEqual(or.lists, Array(cases.length + 1).fill('speech'));
  await llm.addModelById(id, 'chat', 'some/chat-model');
  assert.equal(or.lists.length, cases.length + 1);
  // The id is the list's, whatever case was typed: Kokoro again, typed in another case, is the model just added, refused as already added.
  await assert.rejects(llm.addModelById(id, 'voice', 'HexGrad/Kokoro-82M'), { held: true });
});

test("With no list to read (offline, refused, or no answer in REQUEST_MS), a voice is added by id as before: Women KatKat, which each maker refuses, and the refused sample says what to change, its words as each maker's answer gives them", async (t) => {
  // [id, kind, status, the words a card shows]. HeyGen's, its free variant's and Kokoro's 400 say why; Grok's and Voxtral's 404 is the bare
  // "Provider returned 404", so the card says what to check: the model id, the base URL and the Voice.
  /** @type {[string, string, number, string][]} */
  const answers = [
    ['heygen/heygen-voice-1', 'bad-request', 400, 'The provider didn\'t accept the request: "HTTP 400: Voice not found".'],
    ['heygen/heygen-voice-1-turbo:free', 'bad-request', 400, 'The provider didn\'t accept the request: "HTTP 400: Voice not found".'],
    ['x-ai/grok-voice-tts-1.0', 'not-found', 404, NOT_FOUND],
    ['mistralai/voxtral-mini-tts-2603', 'not-found', 404, NOT_FOUND],
    // Kokoro's reason is long: cut at 120 characters, "Available voices: a…".
    ['hexgrad/kokoro-82m', 'bad-request', 400, `The provider didn't accept the request: "HTTP 400: Voice '${KATKAT}' is not available for model 'hexgrad/Kokoro-82M'. Available voices: a…".`],
  ];
  for (const list of /** @type {const} */ (['offline', 'refused'])) {
    const or = openRouter({ list });
    const o = await added(or);
    for (const [pid, kind, status, words] of answers) {
      const made = await o.byId(pid);
      assert.deepEqual((await o.model(made)).tunables, {}, `${pid}: the ability's voice, as before`);
      const r = await refusedWith(o, sample(o, made));
      assert.equal(or.said.at(-1).voice, KATKAT, pid);
      assert.deepEqual([r.e.kind, r.e.status, r.words], [kind, status, words], `${pid}, the list ${list}`);
    }
  }
  const or = openRouter({ list: 'hangs' });
  const o = await added(or);
  useClock(t);
  const from = Date.now();
  const heygen = await o.llm.addModelById(o.id, 'voice', 'heygen/heygen-voice-1');
  assert.equal(Date.now() - from, REQUEST_MS, 'the add waits for the list as long as annai waits for its other small lists, no longer');
  assert.deepEqual((await o.model(heygen)).tunables, {});
});

test("An id the list doesn't have, and a model its list names no voice for (ByteDance's, which takes none), start with Women KatKat, which they refuse", async () => {
  const or = openRouter();
  const o = await added(or);
  const unlisted = await o.llm.addModelById(o.id, 'voice', 'heygen/heygen-voice-9');
  assert.deepEqual((await o.model(unlisted)).tunables, {}, 'an id the list lacks: by id, as before');
  await refusedWith(o, sample(o, unlisted)); // a ProviderError; the real answer to an id OpenRouter lacks was not recorded
  assert.equal(or.said.at(-1).voice, KATKAT);
  // Its entry lists no voice and its id has no base: nothing in the list gives one, so it starts with the ability's.
  const seed = await o.llm.addModelById(o.id, 'voice', 'bytedance-seed/seed-audio-1-0');
  assert.deepEqual((await o.model(seed)).tunables, { styled: false });
  const r = await refusedWith(o, sample(o, seed));
  assert.equal(or.said.at(-1).voice, KATKAT);
  assert.deepEqual([r.e.kind, r.e.status], ['bad-request', 400]);
  assert.equal(r.words, `The provider didn't accept the request: "Provider rejected the request: speaker ${KATKAT} not found in speaker_map, speaker_audio, or meg…".`, 'cut at 120, the voice named whole');
});

test("The list's voice is used only if the connection it was read under is the one the add lands under (the screen's check, asked after the read)", async () => {
  const or = openRouter();
  const o = await added(or);
  /** @type {number[]} */
  const asked = [];
  const changed = await o.llm.addModelById(o.id, 'voice', 'heygen/heygen-voice-1', async () => { asked.push(or.lists.length); return false; });
  assert.deepEqual(asked, [1], 'asked once, after the list was read');
  assert.deepEqual((await o.model(changed)).tunables, {}, 'from another connection: the list is not used, the ability\'s voice is');
  await removeModel(o.k.ws, changed);
  const same = await o.llm.addModelById(o.id, 'voice', 'heygen/heygen-voice-1', async () => true);
  assert.equal((await o.model(same)).tunables?.voice, 'nadine');
  // Not asked for a model whose list was not read: a chat model's, and an id the list lacks start as they always did.
  await o.llm.addModelById(o.id, 'chat', 'some/chat-model', async () => { throw new Error('asked'); });
});

test("A voice added by id before this build (no voice of its own: the ability's Women KatKat) stays as it was: HeyGen's is refused, its sample says why, and added again it speaks", async () => {
  const or = openRouter();
  const o = await added(or);
  // As the old Add by id stored it: the id in the user's layer, nothing else.
  const old = newModel(o.id, 'voice', { user: { providerId: 'heygen/heygen-voice-1' } });
  await saveModel(o.k.ws, old);
  assert.deepEqual((await o.model(old.id)).tunables, {});
  const { words } = await refusedWith(o, sample(o, old.id));
  assert.equal(or.said.at(-1).voice, KATKAT);
  assert.equal(words, 'The provider didn\'t accept the request: "HTTP 400: Voice not found".');
  await removeModel(o.k.ws, old.id);
  const again = await o.llm.addModelById(o.id, 'voice', 'heygen/heygen-voice-1');
  await sample(o, again);
  assert.equal(or.said.at(-1).voice, 'nadine');
});

test("A refused sample's words: the provider's reason as plain text (outside text, quoted, never read), its keys blanked before it is cut at 120 characters, its spaces and controls one space, its full stop the sentence's, and none when the keys can't be read; a voice's 404 says what to check (model id, base URL, Voice); any other failure, the kind's words as before", async () => {
  const k = await hostKit();
  await k.store.tx(['secrets'], 'readwrite', (t) => t.putSecret('llm:ep-1', KEY));
  const fromBody = (/** @type {number} */ status, /** @type {string} */ body, speaking = true) => speechProblem(k.store, errorFromResponse(status, body), speaking);
  const msg = (/** @type {string} */ message, code = 400) => JSON.stringify({ error: { message, code } });
  // A refusal with its words (84 characters, the longest of the one-sentence ones): kept whole.
  const HEYGEN_NONE = 'An explicit voice is required unless input_references carries a reference recording.';
  assert.equal(await fromBody(400, msg(HEYGEN_NONE)), `The provider didn't accept the request: "${HEYGEN_NONE.slice(0, -1)}".`);
  // HeyGen's refusal of WAV (the voice probe of 2026-11-19): a dump, its lines one, cut.
  const probe = JSON.parse(await readFile(new URL('test/fixtures/voices/openrouter-pcm-probe.json', root), 'utf8'));
  const dump = await fromBody(400, probe.heygenWavRefused.body);
  const quoted = /: "(.*)"\.$/.exec(dump)?.[1] ?? '';
  assert.equal(quoted.length, 120);
  assert.ok(quoted.endsWith('…') && quoted.startsWith('[ { "code": "invalid_value", "values": [ "mp3", "pcm" ]'), quoted);
  assert.equal(await fromBody(400, msg('Bad‮\u0000 voice\n\tname.')), 'The provider didn\'t accept the request: "Bad voice name".', 'no control or direction mark reaches the screen');
  // No words in the answer ("HTTP 400", or OpenRouter's "Provider returned 400"): its kind's, as before.
  for (const body of ['', msg('Provider returned 400'), msg('HTTP 400')]) assert.equal(await fromBody(400, body), "The provider didn't accept the request. Check the tunables on its provider's page.", body);
  // A key across the cut shows none of its characters: blanked first (a cut first would leave its first 18 as the cut fell inside it).
  const across = `${'x'.repeat(100)} ${KEY} echoed`;
  assert.ok(across.indexOf(KEY) < 119 && across.indexOf(KEY) + KEY.length > 119, 'the key crosses character 119');
  const blanked = await fromBody(400, msg(across));
  assert.equal(blanked, `The provider didn't accept the request: "${'x'.repeat(100)} «key» echoed".`);
  assert.ok(!blanked.includes('sk-or'), blanked);
  // A key the blanking can't read (broken by a space) leaves no reason: the kind's words, not a prefix of the key.
  assert.equal(await fromBody(400, msg(`Bad header ${KEY.slice(0, 12)} ${KEY.slice(12)}`)), "The provider didn't accept the request. Check the tunables on its provider's page.");
  // Keys that can't be read (the store fails): no reason at all, whatever the answer says, so a key it echoes can't show; and the status line, which
  // can't be checked either, says so in place of its words (spec §9.9).
  const unreadable = /** @type {any} */ ({ tx: () => Promise.reject(new Error('the store cannot be read')) });
  assert.equal(await speechProblem(unreadable, errorFromResponse(400, msg(`Voice ${KEY} not found`)), true), "annai couldn't check this message for keys, so it is not shown.");
  // A voice's 404: the answer gave no words, so the card says what to check, the Voice too; the same for one with words ("Not Found" of a
  // wrong address says the address too); a transcription model's 404 is its model's or address's.
  const bare = msg('Provider returned 404', 404);
  assert.equal(await fromBody(404, bare), NOT_FOUND);
  assert.equal(await fromBody(404, msg('Not Found', 404)), NOT_FOUND);
  assert.equal(await fromBody(404, bare, false), "The provider doesn't know this model or address. Check the model id and the base URL.");
  // Another kind's words stay its kind's: a rejected key, whatever the provider said, and a failure that has no provider's answer.
  assert.equal(await fromBody(401, msg('No cookie auth credentials found', 401)), 'The key was rejected. Check it in Settings → Models.');
  assert.equal(await speechProblem(k.store, new ProviderError('bad-request', "Voice A isn't a voice.", { said: { code: 'not-out', name: 'Voice A' } }), true), "Voice A isn't a voice.");
  // annai's own not-found (no status) keeps its words.
  assert.equal(await speechProblem(k.store, new ProviderError('not-found', 'That model no longer exists.', { said: { code: 'model-gone' } }), true), 'That model no longer exists.');
  assert.equal(await speechProblem(k.store, new Error('plain'), true), 'plain');
});

test("The stand-in refuses what the real server refused: HeyGen's MP3, with its recorded 400 (a test that sends it MP3 fails as the real one would), and nothing for its PCM", () => {
  for (const model of ['heygen/heygen-voice-1', 'heygen/heygen-voice-1-turbo:free']) {
    const no = refusal({ model, voice: 'nadine', response_format: 'mp3' });
    assert.deepEqual([no?.status, no ? JSON.parse(no.body).error.message : null], [400, 'HeyGen Voice only supports response_format "pcm".'], model);
    assert.equal(refusal({ model, voice: 'nadine', response_format: 'pcm' }), null, model);
  }
  assert.equal(refusal({ model: 'x-ai/grok-voice-tts-1.0', voice: 'eve', response_format: 'mp3' }), null, 'another maker takes MP3');
});
