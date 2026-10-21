import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool, TOOL_MS } from '../../src/core/agent/tools.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { ASK_MS, NOMINATIM_GAP } from '../../src/plugins/places/index.js';

// The emulator pass: a mirror that never answered held Shiori's turn for 7 minutes (shot 274).
const tool = (/** @type {string} */ name, /** @type {any} */ run) => ({ name, description: `The ${name} tool.`, input: { type: 'object' }, run });
const call = (/** @type {AbortSignal} */ signal = new AbortController().signal) => /** @type {any} */ ({ scope: 'trip-1', trip: 'trip-1', signal, model: null, wake: 'w', author: 'shiori' });

/** Runs f with a tool's time limit of ms. @param {number} ms @param {() => Promise<void>} f */
async function limited(ms, f) {
  const was = TOOL_MS.ms;
  TOOL_MS.ms = ms;
  try {
    await f();
  } finally {
    TOOL_MS.ms = was;
  }
}

test('runTool: a tool that never finishes ends at its time limit with an error in words, and its signal stops its work', () => limited(40, async () => {
  /** @type {AbortSignal | null} */
  let seen = null;
  const stop = new AbortController();
  const r = await runTool(tool('nearby', (/** @type {any} */ _i, /** @type {any} */ c) => { seen = c.signal; return new Promise(() => {}); }), {}, call(stop.signal));
  assert.equal(r.output.isError, true);
  assert.match(r.output.content, /^Error: nearby didn't finish in time, so annai stopped waiting for it\./);
  assert.equal(/** @type {any} */ (seen)?.aborted, true);
  assert.equal(stop.signal.aborted, false, "the turn's own signal goes on");
  assert.ok(r.ms >= 35, 'not before its limit');
}));

test('runTool: the user stopping Shiori still says so, within the limit', () => limited(5_000, async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);
  const r = await runTool(tool('nearby', () => new Promise(() => {})), {}, call(stop.signal));
  assert.deepEqual(r.output, { content: 'Stopped by the user.', isError: true });
}));

test('runTool: tools that wait for the user, and the helper of task, have no time limit', () => limited(20, async () => {
  for (const name of ['ask', 'wait', 'speak', 'task']) {
    const r = await runTool(tool(name, () => new Promise((resolve) => setTimeout(() => resolve('answered'), 60))), {}, call());
    assert.deepEqual(r.output, { content: 'answered' }, name);
  }
}));

test('the time limit is above the longest any tool of annai sets itself: an MCP call (2 minutes)', () => {
  assert.ok(TOOL_MS.ms > 120_000);
  assert.ok(ASK_MS.ms * 3 < TOOL_MS.ms, "nearby's three requests, each at its limit, still end before the tool's");
});

async function places() {
  const registry = new Registry();
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/places/index.js', import.meta.url).href);
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** @type {string[]} */
  const asked = [];
  /** A server that never answers, as overpass.private.coffee on 2026-10-21, until its request is called off. @param {string} url @param {any} init */
  const hang = (url, init) => new Promise((_, reject) => {
    asked.push(url);
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  return { tools, asked, hang };
}

test('places: each request has its own time limit; nearby goes on to the next Overpass mirror, then Wikipedia', async () => {
  const was = ASK_MS.ms;
  ASK_MS.ms = 30;
  try {
    const { tools, asked, hang } = await places();
    const wiki = { query: { geosearch: [{ title: 'McWay Falls', lat: 36.1577, lon: -121.6716, dist: 50 }] } };
    const out = await tools.nearby.run({ lat: 36.158, lng: -121.672 }, {
      ...call(), trip: null,
      fetch: async (/** @type {string} */ url, /** @type {any} */ init) => (url.includes('overpass') ? hang(url, init) : new Response(JSON.stringify(wiki))),
    });
    assert.deepEqual(asked.map((u) => new URL(u).hostname), ['overpass-api.de', 'overpass.private.coffee']);
    assert.match(out, /McWay Falls/);
    assert.match(out, /OpenStreetMap didn't answer; these are Wikipedia articles only\.$/);
  } finally {
    ASK_MS.ms = was;
  }
});

test("places: a request past its limit says who didn't answer, in words", async () => {
  const was = [ASK_MS.ms, NOMINATIM_GAP.ms];
  ASK_MS.ms = 30;
  NOMINATIM_GAP.ms = 0;
  try {
    const { tools, hang } = await places();
    await assert.rejects(tools.geocode.run({ query: 'Nepenthe' }, { ...call(), fetch: hang }), { message: "nominatim.openstreetmap.org didn't answer in time." });
    // The user's stop is still the user's stop.
    const stop = new AbortController();
    setTimeout(() => stop.abort(new DOMException('stopped', 'AbortError')), 5);
    ASK_MS.ms = 5_000;
    await assert.rejects(tools.geocode.run({ query: 'Nepenthe' }, { ...call(stop.signal), fetch: hang }), { name: 'AbortError' });
  } finally {
    [ASK_MS.ms, NOMINATIM_GAP.ms] = was;
  }
});
