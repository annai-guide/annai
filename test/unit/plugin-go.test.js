import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { loadBuiltinSkills } from '../../src/plugins/skills/index.js';

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

/** The planning skill, from skills/plan-a-trip/SKILL.md. */
const planning = async () => (await loadBuiltinSkills(async (p) => readFile(new URL(`../..${p}`, import.meta.url), 'utf8').catch(() => null))).find((s) => s.name === 'plan-a-trip');

test('maps_link and search_link give links to show, in the Go group', async () => {
  const { registry, tools, run } = await setup();
  assert.equal(tools.maps_link.group, 'Go');
  assert.equal(tools.search_link.group, 'Go');
  assert.deepEqual((await run('maps_link', { destination: 'Nepenthe' })).links.map((/** @type {any} */ l) => l.label), ['Apple Maps', 'Google Maps']);
  const { links } = await run('search_link', { kind: 'hotel', params: { place: 'Hoboken', checkin: '2026-11-25', checkout: '2026-11-29', adults: 2 } });
  assert.match(links[0].url, /^https:\/\/www\.booking\.com\/searchresults\.html\?ss=Hoboken&checkin=2026-11-25&checkout=2026-11-29&group_adults=2$/);
  const skill = await planning();
  assert.match(skill.text, /getting there, getting around, where to stay, then the rest/);
});

test("search_link takes params only as an object: anything else (JSON text that isn't one, from a model that gives objects as text) is refused in words that say so", async () => {
  const { run } = await setup();
  for (const params of ['{"place": "Hoboken"', 'Hoboken', ['Hoboken'], 3, null]) {
    await assert.rejects(run('search_link', { kind: 'hotel', params }), /^Error: params must be an object of the search's fields, such as \{"place": "Big Sur", "checkin": "2026-11-25"\}, so nothing was searched\./);
  }
  // Left out, it is no fields: the search says which it needs.
  await assert.rejects(run('search_link', { kind: 'hotel' }), /A hotel search needs/);
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
  assert.match((await planning()).text, /show\(\{ card: \{ title, text, links \} \}\)/);
});

test('the planning skill says how to write a whole-day item: kind "all-day", starting at 00:00 where it is', async () => {
  const { registry } = await setup();
  const text = (await planning()).text;
  assert.match(text, /"kind": "all-day"/);
  assert.match(text, /00:00/);
  assert.match(text, /"All day"/);
  assert.match(text, /calendar/);
});
