import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';

async function setup() {
  const registry = new Registry();
  const ws = new Workspace(createMemoryStore(), { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/go/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Thanksgiving' });
  const catalog = await readFile(new URL('../../catalog/links.json', import.meta.url), 'utf8');
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** @param {string} name @param {any} input @param {boolean} [online] */
  const run = (name, input, online = true) => tools[name].run(input, {
    scope: trip, trip, signal: new AbortController().signal, model: { input: ['text'] },
    fetch: async () => { if (!online) throw new TypeError('Failed to fetch'); return new Response(catalog, { status: 200 }); },
  });
  return { registry, tools, run };
}

test('maps_link and search_link give links to show, in the Go group; the planning skill is there', async () => {
  const { registry, tools, run } = await setup();
  assert.equal(tools.maps_link.group, 'Go');
  assert.equal(tools.search_link.group, 'Go');
  assert.deepEqual((await run('maps_link', { destination: 'Nepenthe' })).links.map((/** @type {any} */ l) => l.label), ['Apple Maps', 'Google Maps']);
  const { links } = await run('search_link', { kind: 'hotel', params: { place: 'Hoboken', checkin: '2026-11-25', checkout: '2026-11-29', adults: 2 } });
  assert.match(links[0].url, /^https:\/\/www\.booking\.com\/searchresults\.html\?ss=Hoboken&checkin=2026-11-25&checkout=2026-11-29&group_adults=2$/);
  const skill = registry.list('skill').find((s) => s.name === 'plan-a-trip');
  assert.match(skill.text, /getting there, getting around, where to stay, then the rest/);
});

test('without the catalog, the tools say so plainly', async () => {
  const { run } = await setup();
  await assert.rejects(run('maps_link', { destination: 'Nepenthe' }, false), /hasn't downloaded its link formats yet/);
});

test('the Go tools and the planning skill teach a show call that works: show({ card: { links } })', async () => {
  const { registry, tools } = await setup();
  for (const t of [tools.maps_link, tools.search_link]) {
    assert.match(t.description, /show\(\{ card: \{ links \} \}\)/);
    assert.doesNotMatch(t.description, /show\(\{ links \}\)/);
  }
  assert.match(registry.list('skill').find((s) => s.name === 'plan-a-trip').text, /show\(\{ card: \{ title, text, links \} \}\)/);
});
