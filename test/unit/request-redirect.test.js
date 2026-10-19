import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callOnce } from '../../src/core/llm/call.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { testModel } from '../../src/core/llm/check.js';
import { ProviderError } from '../../src/core/llm/contract.js';

// Fix pass (the re-review's probe): a request that carries a key never follows a redirect, as a 30x from the
// agreed address would forward key headers that aren't Authorization (x-api-key, a keyHeader) and the body.

/** A provider answering 307 to another server on its own port, which notes what reached it. */
async function servers() {
  /** @type {any[]} */
  const seen = [];
  const other = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => other.listen(0, '127.0.0.1', () => r(undefined)));
  const otherOrigin = `http://127.0.0.1:${/** @type {any} */ (other.address()).port}`;
  const provider = http.createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: `${otherOrigin}/elsewhere` });
    res.end();
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', () => r(undefined)));
  const origin = `http://127.0.0.1:${/** @type {any} */ (provider.address()).port}`;
  return { seen, origin, stop: () => { other.close(); provider.close(); } };
}

const KEY = 'sk-not-a-real-key-123';
/** @param {string} baseUrl @returns {any} */
const endpoint = (baseUrl) => ({ id: 'p/chat', provider: 'p', ability: 'chat', type: 't', name: 'P', baseUrl, headers: {}, tunables: {}, extraBody: {} });
/** @type {any} */
const model = { id: 'm', provider: 'p', ability: 'chat', providerId: 'm', name: 'm', input: ['text', 'image'], tools: true, reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], images: {}, prices: null, cacheTtls: [] };
const keyed = (/** @type {string | null} */ key) => ({ authorization: `Bearer ${key}`, 'x-api-key': String(key), 'x-custom-key': String(key), 'content-type': 'application/json' });
/** @type {any} */
const type = {
  type: 't', name: 'T', pluginId: 'x',
  build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: keyed(c.key), body: { hello: 'world' } }),
  async *read() { yield { type: 'text', text: 'ok' }; },
  uploadRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/files`, headers: keyed(c.key), body: new FormData() }),
  readUpload: () => ({ id: 'file-1' }),
};
const redirected = (/** @type {any} */ e) => e instanceof ProviderError && e.kind === 'redirect' && /P answered with a redirect, which annai doesn't follow with your key/.test(e.message);

test("a call, a speech call and Test's upload never follow a redirect: nothing reaches the other address, and the words say why", async () => {
  const s = await servers();
  try {
    const request = /** @type {any} */ ({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });
    await assert.rejects(callOnce({ type, endpoint: endpoint(s.origin), model, key: KEY, request }), redirected);
    /** @type {any} */
    const voice = { type: 'v', name: 'V', pluginId: 'x', speech: 'out', speechRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/audio/speech`, headers: keyed(c.key), body: '{}' }), readSpeech: async () => ({ data: new Uint8Array(1), mediaType: 'audio/mpeg' }) };
    await assert.rejects(speechCall({ type: voice, endpoint: endpoint(s.origin), model, key: KEY, text: 'Hello.' }), redirected);
    const result = await testModel({ type: { ...type, build: () => ({ url: `${s.origin}/v1/chat`, headers: {}, body: {} }) }, endpoint: endpoint(s.origin), model, key: KEY });
    assert.match(result.steps[0].detail, /^P answered with a redirect/, 'the words name the provider');
    assert.deepEqual(s.seen, [], 'no key, no body, went anywhere else');
  } finally {
    s.stop();
  }
});

test('every fetch that carries a key asks not to follow redirects; a browser\'s opaque redirect answer is refused too', async () => {
  /** @type {any[]} */
  const inits = [];
  const opaque = /** @type {any} */ ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), text: async () => '' });
  const fetch = async (/** @type {any} */ _url, /** @type {any} */ init) => { inits.push(init); return opaque; };
  const request = /** @type {any} */ ({ messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', hash: 'h1' }] }] });
  const uploads = /** @type {any} */ ({ isOff: () => false, get: async () => null, set: async () => {}, off: () => {}, forget: async () => {} });
  await assert.rejects(callOnce({ type, endpoint: endpoint('https://llm.example'), model, key: KEY, request, fetch, uploads }), redirected);
  assert.equal(inits.length, 2, 'the upload, then the request');
  assert.ok(inits.every((i) => i.redirect === 'manual'));
  // Test: the request answers, the upload is redirected, and the upload step says so in words.
  const answered = async (/** @type {any} */ url, /** @type {any} */ init) => { inits.push(init); return String(url).endsWith('/v1/files') ? opaque : new Response('{}'); };
  const result = await testModel({ type, endpoint: endpoint('https://llm.example'), model, key: KEY, fetch: answered });
  assert.match(/** @type {any} */ (result.steps.find((x) => x.step === 'upload')).detail, /^P answered with a redirect, which annai doesn't follow with your key\. Check its address\. annai will send photos/);
  assert.ok(inits.length > 2 && inits.every((i) => i.redirect === 'manual'));
});
