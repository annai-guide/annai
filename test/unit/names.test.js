import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { Registry } from '../../src/core/registry.js';
import { ensureBaseScopes, createTrip, kindOf } from '../../src/core/scopes.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { readNames, shortName, NAMES_FILE, NAME_MAX } from '../../src/core/names.js';

const SYS_WAITING = 'sys:waiting';

async function kit() {
  const registry = new Registry();
  for (const s of CORE_SCHEMAS) registry.add('core-schemas', 'schema', s);
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Anchorage' });
  const other = await createTrip(ws, { title: 'Kyoto' });
  await store.tx(['scopes'], 'readwrite', (t) => t.putScope({ id: SYS_WAITING, kind: 'sys', title: 'Waiting with Shiori', status: 'active', created: 0, updated: 0, format: 1 }));
  return { store, ws, trip, other };
}

test('readNames: the names Shiori gave, by path; none when there is no names.json, or it is not an object', async () => {
  const { ws, trip, other } = await kit();
  assert.equal(NAMES_FILE, '/names.json');
  await ws.write(trip, '/names.json', { '/files/IMG_3021.PNG': 'Hotel Aurora Test · Nov 20–27' }, { author: 'shiori' });
  assert.deepEqual(await readNames(ws, trip), { '/files/IMG_3021.PNG': 'Hotel Aurora Test · Nov 20–27' });
  assert.deepEqual(await readNames(ws, other), {});
  // One written before the format check, or broken: none, never a throw.
  await ws.write(other, '/names.json', '[1, 2]', { author: 'user', type: 'text/plain' });
  assert.deepEqual(await readNames(ws, other), {});
  await ws.write(other, '/names.json', 'not json', { author: 'user', type: 'text/plain' });
  assert.deepEqual(await readNames(ws, other), {});
});

test('shortName: her name, else the file name itself', () => {
  assert.equal(shortName({ '/files/a.pdf': 'ANNAI AIR flight · Nov 20' }, '/files/a.pdf'), 'ANNAI AIR flight · Nov 20');
  assert.equal(shortName({}, '/files/Your flight is booked.pdf'), 'Your flight is booked.pdf');
});

test('names.json takes only paths under /files/ with names of 1 to 80 characters', async () => {
  const { ws, trip } = await kit();
  assert.equal(NAME_MAX, 80);
  await ws.write(trip, '/names.json', { '/files/a.pdf': 'x'.repeat(80) }, { author: 'shiori' });
  await assert.rejects(ws.write(trip, '/names.json', { '/files/a.pdf': 'x'.repeat(81) }, { author: 'shiori' }), ValidationError);
  await assert.rejects(ws.write(trip, '/names.json', { '/files/a.pdf': '' }, { author: 'shiori' }), ValidationError);
  await assert.rejects(ws.write(trip, '/names.json', { '/notes/a.md': 'A note' }, { author: 'shiori' }), ValidationError);
  await assert.rejects(ws.write(SYS_WAITING, '/names.json', { '/files/a.pdf': 7 }, { author: 'shiori' }), ValidationError);
  await ws.write(SYS_WAITING, '/names.json', { '/files/a.pdf': 'ANNAI AIR flight · Nov 20' }, { author: 'shiori' });
});
