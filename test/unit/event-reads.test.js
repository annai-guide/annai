import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, recordBackup, backupState } from '../../src/core/scopes.js';
import { logEvent } from '../../src/core/events.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { noteQueries } from './store-spy.js';

/** A trip after a day of driving: a conversation, and 2000 location points among it. */
async function drivenTrip() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await logEvent(store, trip, { type: 'wake', actor: 'system', data: { id: 'w1', reasons: [{ kind: 'user', text: 'typed' }] } });
  await logEvent(store, trip, { type: 'msg.user', actor: 'user', data: { text: 'Where is dinner tonight?' } });
  for (let i = 0; i < 2000; i++) await logEvent(store, trip, { type: 'location', actor: 'system', data: { lat: 36 + i / 1e4, lng: -121.9, accuracy: 8 } });
  return { store, ws, trip };
}

const byType = (/** @type {any} */ q) => Array.isArray(q.types) && q.types.length > 0 && !q.types.includes('location');

test("opening a conversation reads only the entries it shows, by type: a day's location points aren't walked (A6)", async () => {
  const { store, trip } = await drivenTrip();
  const queries = noteQueries(store);
  const t = await Transcript.load(store, trip);
  assert.match(JSON.stringify(t.messages), /Where is dinner tonight\?/);
  assert.ok(queries.length > 0 && queries.every(byType), JSON.stringify(queries));
});

test('recall reads its conversation by type too', async () => {
  const { store, trip } = await drivenTrip();
  const recall = selfTools(/** @type {any} */ ({ store, scope: trip })).find((x) => x.name === 'recall');
  const queries = noteQueries(store);
  const out = await recall?.run({ query: 'dinner' }, /** @type {any} */ ({}));
  assert.match(String(out), /Where is dinner tonight\?/);
  assert.ok(queries.length > 0 && queries.every(byType), JSON.stringify(queries));
});

test('whether a trip changed since its backup reads one entry, not all that came after', async () => {
  const { store, trip } = await drivenTrip();
  await recordBackup(store, new Map([[trip, 1]]), 1000);
  const queries = noteQueries(store);
  assert.equal((await backupState(store, trip)).changed, true);
  assert.ok(queries.every((q) => q.limit === 1), JSON.stringify(queries));
});
