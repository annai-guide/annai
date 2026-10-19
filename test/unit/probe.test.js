import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probe } from '../../plugins-official/provider-another-address/probe.js';
import { addressProblem } from '../../src/core/llm/provider-desc.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { SYS } from '../../src/core/scopes.js';
import { startFakeServer } from '../fakes/model-server.js';
import { browserFetch } from '../fakes/browser-fetch.js';
import { hostKit } from './package-kit.js';

// Another address looks for what a server offers, at no cost (milestone 5 of providers as plugins,
// decision 18): its model list, and an empty request to each path annai knows, read against a control
// request to a path that can't exist. Stand-ins answer as each server does, reached as a page at annai's
// address reaches them (a browser's CORS rules); reach is the check a browser makes without those rules.

const ANNAI = 'https://annai.guide';
const KEY = 'sk-test-probe-0123456789';

/** @param {{ fetch?: any, reach?: (url: string) => Promise<boolean> }} [o] */
const io = (o = {}) => ({
  fetch: o.fetch ?? browserFetch(ANNAI),
  reach: o.reach ?? ((/** @type {string} */ url) => fetch(url).then(() => true, () => false)),
  problem: addressProblem,
});
/** Each finding's state, by what was looked for. @param {any} r */
const states = (r) => ({ list: r.list.state, ...Object.fromEntries(Object.entries(r.abilities).map(([id, f]) => [id, /** @type {any} */ (f).state])) });

/**
 * A server that answers every request with what answer() gives, letting any page read it (CORS), as
 * some servers in front of models do. @param {(req: http.IncomingMessage) => [number, Record<string, string>, string]} answer
 */
async function tiny(answer) {
  /** @type {{ method: string, path: string, headers: any }[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? '') };
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', headers: { ...req.headers } });
    const [status, headers, body] = answer(req);
    res.writeHead(status, { ...cors, ...headers }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { origin: `http://127.0.0.1:${port}`, requests, stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }) };
}

test('a router like maiGo: the list, Chat Completions and Responses are found; Messages and the audio paths are absent; without the key, the paths it has say they ask for one', async () => {
  const s = await startFakeServer({ flavour: 'whole', key: KEY });
  try {
    const r = await probe(`${s.origin}/v1`, KEY, io());
    assert.deepEqual([r.base, r.root], [`${s.origin}/v1`, s.origin]);
    assert.deepEqual(states(r), { list: 'found', 'chat-completions': 'found', responses: 'found', messages: 'absent', transcription: 'absent', voice: 'absent' });
    assert.equal(r.list.count, 1);
    const bare = await probe(`${s.origin}/v1/`, null, io());
    assert.deepEqual(states(bare), states(r), 'an unknown path is 404 without the key, so a 401 says the path is there');
    assert.match(bare.abilities['chat-completions'].why ?? '', /asks for a key/);
    assert.equal(bare.list.count, undefined, 'it listed nothing without the key');
  } finally {
    await s.stop();
  }
});

test('llama.cpp: the list, Chat Completions, Responses and Messages at the root are found', async () => {
  const s = await startFakeServer({ flavour: 'llamacpp' });
  try {
    const r = await probe(`${s.origin}/v1`, null, io());
    assert.deepEqual(states(r), { list: 'found', 'chat-completions': 'found', responses: 'found', messages: 'found', transcription: 'absent', voice: 'absent' });
    assert.equal(r.root, s.origin, 'Anthropic Messages adds /v1/messages to the address without /v1');
    assert.ok(s.requests.some((q) => q.method === 'POST' && q.path === '/v1/messages' && q.headers['anthropic-version'] === '2023-06-01'), 'asked as Anthropic Messages asks');
  } finally {
    await s.stop();
  }
});

test('a server that answers 401 on every path without a key reports unknown, never found, and says to give the key; with the key it finds what it has (Review Focus 5)', async () => {
  const s = await startFakeServer({ flavour: 'whole', key: KEY, authEverywhere: true });
  try {
    const r = await probe(`${s.origin}/v1`, null, io());
    assert.deepEqual(Object.values(states(r)).filter((x) => x === 'found'), []);
    assert.equal(r.abilities['chat-completions'].state, 'unknown');
    assert.match(r.abilities['chat-completions'].why ?? '', /give the key/);
    assert.equal(r.list.state, 'unknown');
    const keyed = await probe(`${s.origin}/v1`, KEY, io());
    assert.deepEqual(states(keyed), { list: 'found', 'chat-completions': 'found', responses: 'found', messages: 'unknown', transcription: 'absent', voice: 'absent' },
      'Messages sends the key its own way (x-api-key), which this server refuses at any address: no telling');
    assert.match(keyed.abilities.messages.why ?? '', /key/);
  } finally {
    await s.stop();
  }
});

test('a web app that answers 200 with a page for any path finds nothing (Review Focus 5)', async () => {
  const s = await startFakeServer({ flavour: 'whole', spa: true });
  try {
    const r = await probe(`${s.origin}/app`, null, io());
    assert.deepEqual(states(r), { list: 'absent', 'chat-completions': 'absent', responses: 'absent', messages: 'absent', transcription: 'absent', voice: 'absent' });
    assert.match(r.abilities.voice.why ?? '', /web page/);
  } finally {
    await s.stop();
  }
  // One that answers JSON to anything, the address that can't exist too, is no telling either.
  const any = await tiny(() => [200, { 'content-type': 'application/json' }, '{"ok":true}']);
  try {
    const r = await probe(`${any.origin}/v1`, null, io());
    assert.deepEqual(Object.values(states(r)).filter((x) => x === 'found'), []);
    assert.equal(r.abilities['chat-completions'].state, 'unknown');
  } finally {
    await any.stop();
  }
});

test("a server that doesn't allow web apps is blocked, told apart from one that isn't there (unreachable)", async () => {
  const s = await startFakeServer({ flavour: 'whole', cors: false });
  let asked = 0;
  try {
    const r = await probe(`${s.origin}/v1`, KEY, io({ reach: (url) => { asked += 1; return fetch(url).then(() => true, () => false); } }));
    assert.deepEqual(new Set(Object.values(states(r))), new Set(['blocked']));
    assert.match(r.abilities['chat-completions'].why ?? '', /doesn't allow web apps/);
    assert.equal(asked, 1, 'the server is checked for once');
  } finally {
    await s.stop();
  }
  const gone = await tiny(() => [200, {}, '']);
  const address = `${gone.origin}/v1`;
  await gone.stop();
  const r = await probe(address, KEY, io());
  assert.deepEqual(new Set(Object.values(states(r))), new Set(['unreachable']));
  assert.match(r.list.why ?? '', /couldn't reach/);
});

test('an address without /v1 is also tried with it; 429 and 5xx are unknown', async () => {
  const s = await startFakeServer({ flavour: 'llamacpp' });
  try {
    const r = await probe(s.origin, null, io());
    assert.deepEqual([r.base, r.root], [`${s.origin}/v1`, s.origin]);
    assert.deepEqual(states(r), { list: 'found', 'chat-completions': 'found', responses: 'found', messages: 'found', transcription: 'absent', voice: 'absent' });
    // One that lists its models at both but talks only at /v1, as the user's Unsloth Studio does (measured 2026-10-19).
    const both = await tiny((req) => {
      const list = [200, { 'content-type': 'application/json' }, '{"object":"list","data":[{"id":"m"}]}'];
      if (req.method === 'GET') return /** @type {any} */ (req.url === '/models' || req.url === '/v1/models' ? list : [404, {}, '']);
      return req.url === '/v1/chat/completions' || req.url === '/v1/messages' ? [400, { 'content-type': 'application/json' }, '{}'] : [405, { 'content-type': 'application/json' }, '{}'];
    });
    try {
      const r = await probe(both.origin, null, io());
      assert.equal(r.base, `${both.origin}/v1`);
      assert.deepEqual(states(r), { list: 'found', 'chat-completions': 'found', responses: 'absent', messages: 'found', transcription: 'absent', voice: 'absent' });
    } finally {
      await both.stop();
    }
    // An address with a path is looked at as given.
    const path = await probe(`${s.origin}/llm`, null, io());
    assert.equal(path.base, `${s.origin}/llm`);
    assert.equal(path.abilities['chat-completions'].state, 'absent');
  } finally {
    await s.stop();
  }
  for (const status of [429, 500, 503]) {
    const t = await tiny(() => [status, { 'content-type': 'application/json' }, '{"error":{"message":"later"}}']);
    try {
      const r = await probe(`${t.origin}/v1`, null, io());
      assert.deepEqual(new Set(Object.values(states(r))), new Set(['unknown']), String(status));
      assert.equal(r.abilities.responses.status, status);
    } finally {
      await t.stop();
    }
  }
});

test('no request carries a model or an input, so nothing can generate; the key goes only in its header, only to the address, never past a redirect, and is in no trace entry', async () => {
  const k = await hostKit();
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY });
  const elsewhere = await startFakeServer({ flavour: 'whole' });
  const moved = await tiny(() => [307, { location: `${elsewhere.origin}/v1/chat/completions` }, '']);
  try {
    const traced = tracedFetch(k.store, SYS, { tool: 'plugin:provider-another-address' }, browserFetch(ANNAI));
    await probe(s.origin, KEY, io({ fetch: traced }));
    assert.ok(s.requests.length >= 14, 'the address as given, then with /v1');
    for (const q of s.requests) {
      if (q.method === 'POST') assert.deepEqual(q.body, {}, `${q.path}: an empty request`);
      else assert.equal(q.body, '', `${q.method} ${q.path}`); // a GET, or a browser's preflight
      assert.ok(!q.path.includes(KEY), q.path);
      const holding = Object.entries(q.headers).filter(([, v]) => String(v).includes(KEY)).map(([h, v]) => `${h}: ${v}`);
      assert.ok(holding.every((x) => x === `authorization: Bearer ${KEY}` || x === `x-api-key: ${KEY}`), holding.join(', '));
    }
    const trace = JSON.stringify(await k.log());
    assert.ok(trace.includes('net.request') && trace.includes('/v1/chat/completions'), 'each request is in the trace');
    assert.ok(!trace.includes(KEY), 'the key is in no trace entry');

    const r = await probe(`${moved.origin}/v1`, KEY, io());
    assert.equal(elsewhere.requests.length, 0, 'a redirect is never followed');
    assert.equal(r.abilities['chat-completions'].state, 'unknown');
    assert.match(r.abilities['chat-completions'].why ?? '', /redirect/);
  } finally {
    await Promise.all([s.stop(), elsewhere.stop(), moved.stop()]);
  }
});

test('an address annai takes keys to, alone, is checked before anything is sent: https, or http only for this device', async () => {
  let sent = 0;
  const counting = io({ fetch: async () => { sent += 1; return new Response('{}'); } });
  await assert.rejects(probe('http://192.168.1.20:8080/v1', KEY, counting), /HTTPS in front of it/);
  await assert.rejects(probe('llm.example.com/v1', KEY, counting), /isn't a web address/);
  await assert.rejects(probe('https://me:secret@llm.example.com/v1', KEY, counting), /alone/);
  await assert.rejects(probe('https://llm.example.com/v1?key=abc', KEY, counting), /alone/);
  await assert.rejects(probe('', KEY, counting), /Give the server's address/);
  await assert.rejects(probe('https://llm.example.com/v1', 'sk-two\nlines', counting), /paste it again/);
  assert.equal(sent, 0);
});
